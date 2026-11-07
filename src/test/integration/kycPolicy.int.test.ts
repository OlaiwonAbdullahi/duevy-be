import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../config/db";
import { MemoryFileStore, setFileStore } from "../../lib/storage";
import { type FakeVerifier } from "../../providers/identity";
import { createCheckout } from "../../services/checkout.service";
import {
  DEFAULT_KYC_POLICY,
  setKycPolicy,
} from "../../services/kycPolicy.service";
import {
  api,
  apiMultipart,
  installFakeProvider,
  installFakeVerifier,
  makeSpace,
  PNG_BYTES,
  startHttp,
  stopHttp,
  tokenFor,
} from "./fixtures";

/**
 * The admin-set KYC policy. Default: student ID + a face capture (photo or
 * short video from the app), both approved by an admin; NIN optional and
 * never sent to Didit. Admins can require NIN or drop the face capture.
 */

let verifier: FakeVerifier;
const store = new MemoryFileStore();
beforeAll(async () => {
  installFakeProvider();
  verifier = installFakeVerifier();
  setFileStore(store);
  await setKycPolicy("test", DEFAULT_KYC_POLICY);
  await startHttp();
});
beforeEach(() => verifier.reset());
afterAll(async () => {
  await setKycPolicy("test", DEFAULT_KYC_POLICY);
  await stopHttp();
});

const card = { bytes: PNG_BYTES, name: "card.png", type: "image/png" };
const selfie = {
  bytes: Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(64, 2),
  ]),
  name: "face.jpg",
  type: "image/jpeg",
};
const video = {
  bytes: Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    Buffer.alloc(256, 3),
  ]),
  name: "face.webm",
  type: "video/webm",
};

async function admin(
  perms: Partial<Record<"userManagement" | "overrides", boolean>> = {
    userManagement: true,
    overrides: true,
  },
) {
  const a = await db.user.create({
    data: {
      name: "Admin",
      email: `adm_${Date.now()}_${Math.random()}@test.duevy`,
      role: "admin",
      adminSubRole: "super_admin",
    },
  });
  await db.adminPermission.create({
    data: {
      userId: a.id,
      payouts: false,
      disputes: false,
      userManagement: false,
      overrides: false,
      ...perms,
    },
  });
  return tokenFor(a);
}

describe("default policy: student ID + face capture, NIN optional", () => {
  it("verifies a rep with no NIN once an admin approves both the student ID and the face capture", async () => {
    const { rep, space, students, dues } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);

    const status = await api("GET", "/v1/me/kyc-status", { token });
    expect(status.body.data.requirements).toEqual({
      nin: false,
      studentId: true,
      liveness: true,
    });

    // The face capture is required.
    const noFace = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      files: { studentIdCard: card },
    });
    expect(noFace.status).toBe(400);
    expect(noFace.body.error.details).toEqual([
      { field: "liveness", issue: "required" },
    ]);

    // A NIN sent while it's off is ignored: nothing goes to Didit, nothing is stored.
    const sub = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      fields: { nin: "12345678901", dob: "2001-04-12" },
      files: { studentIdCard: card, liveness: selfie },
    });
    expect(sub.status).toBe(202);
    expect(verifier.calls).toHaveLength(0);
    expect(sub.body.data).toMatchObject({
      canCollect: false,
      studentId: { status: "pending" },
      liveness: { status: "pending" },
    });
    const stored = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(stored).toMatchObject({
      kycStatus: "unverified",
      ninCheckOutcome: null,
      livenessMimeType: "image/jpeg",
    });
    expect(JSON.stringify(stored)).not.toContain("12345678901");

    // Not collecting until both are approved.
    await expect(
      createCheckout(students[0]!.id, [dues[0]!.id]),
    ).rejects.toMatchObject({ code: "SPACE_NOT_VERIFIED" });
    const adm = await admin();
    expect(
      (
        await api("POST", `/v1/admin/users/${rep.id}/student-id/review`, {
          token: adm,
          body: { decision: "approved" },
        })
      ).body.data.canCollect,
    ).toBe(false);

    // The admin sees the capture next to the student ID card.
    const queue = await api("GET", "/v1/admin/kyc/liveness", { token: adm });
    const row = queue.body.data.find(
      (r: { userId: string }) => r.userId === rep.id,
    );
    expect(row.liveness).toMatchObject({
      status: "pending",
      kind: "photo",
      mimeType: "image/jpeg",
      viewUrl: expect.stringContaining("memory://"),
    });
    expect(row.studentId.viewUrl).toEqual(expect.stringContaining("memory://"));

    const approved = await api(
      "POST",
      `/v1/admin/users/${rep.id}/liveness/review`,
      { token: adm, body: { decision: "approved" } },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.data.canCollect).toBe(true);
    const n = await db.notification.findFirst({
      where: { userId: rep.id, title: "Face capture approved" },
    });
    expect(n?.detail).toBe("Your spaces can now collect payments.");
    await expect(
      createCheckout(students[0]!.id, [dues[0]!.id]),
    ).resolves.toBeTruthy();
    expect(
      await db.adminAuditLog.count({
        where: { action: "user.liveness_review", target: rep.id },
      }),
    ).toBe(1);
  });

  it("takes a short video, refuses non-media, and lets a rejected capture be retaken (old file deleted)", async () => {
    const { rep, space } = await makeSpace({ verified: false });
    const token = await tokenFor(rep);
    const html = {
      bytes: Buffer.from("<html><script>alert(1)</script></html>".padEnd(64)),
      name: "face.mp4",
      type: "video/mp4",
    };
    const pdf = {
      bytes: Buffer.from("%PDF-1.7".padEnd(64)),
      name: "face.pdf",
      type: "application/pdf",
    };
    for (const bad of [html, pdf]) {
      const r = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
        token,
        files: { studentIdCard: card, liveness: bad },
      });
      expect(r.status).toBe(400);
      expect(r.body.error.details[0].field).toBe("liveness");
    }

    const sub = await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
      token,
      files: { studentIdCard: card, liveness: video },
    });
    expect(sub.status).toBe(202);
    const first = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(first.livenessMimeType).toBe("video/webm");
    expect(store.files.has(first.livenessFileId!)).toBe(true);

    // Can't retake while it's awaiting review.
    expect(
      (
        await apiMultipart("/v1/me/kyc/liveness", {
          token,
          files: { liveness: selfie },
        })
      ).status,
    ).toBe(409);

    const adm = await admin();
    const queue = await api("GET", "/v1/admin/kyc/liveness", { token: adm });
    expect(
      queue.body.data.find((r: { userId: string }) => r.userId === rep.id)
        .liveness.kind,
    ).toBe("video");
    expect(
      (
        await api("POST", `/v1/admin/users/${rep.id}/liveness/review`, {
          token: adm,
          body: { decision: "rejected" },
        })
      ).status,
    ).toBe(400); // a reason is required
    expect(
      (
        await api("POST", `/v1/admin/users/${rep.id}/liveness/review`, {
          token: adm,
          body: { decision: "rejected", note: "Face not visible" },
        })
      ).status,
    ).toBe(200);

    const retake = await apiMultipart("/v1/me/kyc/liveness", {
      token,
      files: { liveness: selfie },
    });
    expect(retake.status).toBe(202);
    expect(retake.body.data.liveness.status).toBe("pending");
    const second = await db.user.findUniqueOrThrow({ where: { id: rep.id } });
    expect(second.livenessFileId).not.toBe(first.livenessFileId);
    expect(store.files.has(first.livenessFileId!)).toBe(false);
  });

  it("a rep verified before liveness existed (approved, no capture on file) can add a real capture", async () => {
    const { rep } = await makeSpace({ verified: true }); // fixture: livenessStatus approved, no file
    const res = await apiMultipart("/v1/me/kyc/liveness", {
      token: await tokenFor(rep),
      files: { liveness: selfie },
    });
    expect(res.status).toBe(202);
    expect(res.body.data.liveness.status).toBe("pending");
  });
});

describe("admin KYC settings", () => {
  it("toggles NIN and liveness, applies them to every rep at once, needs the overrides permission, and is audited", async () => {
    const adm = await admin();
    const viewer = await admin({ userManagement: true, overrides: false });

    expect(
      (await api("GET", "/v1/admin/settings/kyc", { token: viewer })).body.data,
    ).toMatchObject({
      ninRequired: false,
      livenessRequired: true,
      studentIdRequired: true,
    });
    expect(
      (
        await api("PUT", "/v1/admin/settings/kyc", {
          token: viewer,
          body: { ninRequired: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("PUT", "/v1/admin/settings/kyc", { token: adm, body: {} }))
        .status,
    ).toBe(400);

    // A rep verified without a NIN (student ID + face capture approved).
    const { rep, students, dues } = await makeSpace({
      verified: false,
      members: 2,
    });
    await db.user.update({
      where: { id: rep.id },
      data: { studentIdStatus: "approved", livenessStatus: "approved" },
    });
    await expect(
      createCheckout(students[0]!.id, [dues[0]!.id]),
    ).resolves.toBeTruthy();

    // Requiring NIN applies at once: that space stops collecting until the rep passes it.
    try {
      const on = await api("PUT", "/v1/admin/settings/kyc", {
        token: adm,
        body: { ninRequired: true },
      });
      expect(on.status).toBe(200);
      expect(on.body.data).toMatchObject({
        ninRequired: true,
        livenessRequired: true,
      });
      expect(on.body.data.leadRepsNotMeetingPolicy).toBeGreaterThanOrEqual(1);
      await expect(
        createCheckout(students[1]!.id, [dues[0]!.id]),
      ).rejects.toMatchObject({ code: "SPACE_NOT_VERIFIED" });
      expect(
        (await api("GET", "/v1/me/kyc-status", { token: await tokenFor(rep) }))
          .body.data,
      ).toMatchObject({
        canCollect: false,
        requirements: { nin: true, studentId: true, liveness: true },
      });
    } finally {
      // Back off: collecting again, no redeploy.
      await api("PUT", "/v1/admin/settings/kyc", {
        token: adm,
        body: { ninRequired: false },
      });
    }
    await expect(
      createCheckout(students[1]!.id, [dues[0]!.id]),
    ).resolves.toBeTruthy();

    const audits = await db.adminAuditLog.findMany({
      where: { action: "settings.kyc_policy" },
      orderBy: { createdAt: "asc" },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.at(-2)!.metadata).toMatchObject({
      before: { ninRequired: false },
      after: { ninRequired: true },
    });
  });

  it("with liveness switched off, a rep collects on the student ID alone", async () => {
    const adm = await admin();
    await api("PUT", "/v1/admin/settings/kyc", {
      token: adm,
      body: { livenessRequired: false },
    });
    try {
      const { rep, space, students, dues } = await makeSpace({
        verified: false,
      });
      const token = await tokenFor(rep);
      expect(
        (
          await apiMultipart(`/v1/spaces/${space.id}/payout/kyc`, {
            token,
            files: { studentIdCard: card },
          })
        ).status,
      ).toBe(202);
      await api("POST", `/v1/admin/users/${rep.id}/student-id/review`, {
        token: adm,
        body: { decision: "approved" },
      });
      await expect(
        createCheckout(students[0]!.id, [dues[0]!.id]),
      ).resolves.toBeTruthy();
    } finally {
      await api("PUT", "/v1/admin/settings/kyc", {
        token: adm,
        body: { livenessRequired: true },
      });
    }
  });
});
