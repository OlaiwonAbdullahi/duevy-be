import { describe, expect, it } from 'vitest';
import { repairPayLink, looksLikeFabricatedLive, isApproval } from './agent';

describe('isApproval — only a plain "yes" triggers deterministic create', () => {
  it('accepts bare approvals, with trailing punctuation/emoji', () => {
    for (const t of ['yes', 'Yes', 'YES!', 'yep', 'yeah', 'yup', 'sure', 'ok', 'okay', 'go ahead', 'do it', 'make it live', 'publish', 'confirm', 'proceed', 'yes 👍', 'yes please']) {
      expect(isApproval(t)).toBe(true);
    }
  });

  it('rejects approvals that carry a change or a refusal', () => {
    for (const t of ['no', 'nope', 'yes but make it ₦3,000', 'yes change the title', 'actually make it a draft', 'wait', 'how much is the fee?', '']) {
      expect(isApproval(t)).toBe(false);
    }
  });
});

const REAL = 'https://duevy.pxxlspace.cv/pay/due_01M7J5H5SX3CH92BGEE5V9BVFN';

describe('repairPayLink — a real link was produced this turn', () => {
  it('rewrites a hallucinated wrong-host/wrong-path URL to the real link', () => {
    const out = repairPayLink('🎉 You\'re live! Share this: https://duevy.com/duevy.app/d/cmw650v3k00048olwm5j9zn1h', REAL);
    expect(out).toContain(REAL);
    expect(out).not.toContain('duevy.com');
    expect(out).not.toContain('/d/');
  });

  it('replaces a markdown link and a [Link to pay] placeholder', () => {
    expect(repairPayLink('Pay here: [tap to pay](https://x.y/pay/abc)', REAL)).toContain(REAL);
    expect(repairPayLink('Share this [Link to pay] with students', REAL)).toContain(REAL);
  });

  it('appends the real link when the model forgot to include one', () => {
    expect(repairPayLink("You're live!", REAL)).toBe(`You're live!\n${REAL}`);
  });

  it('leaves a bare brand mention (no path) alone', () => {
    const out = repairPayLink(`Questions? See duevy.app. ${REAL}`, REAL);
    expect(out).toContain('duevy.app.');
    expect(out).toContain(REAL);
  });
});

describe('repairPayLink — NO real link this turn (nothing was created)', () => {
  it('strips a fabricated URL so a dead link never reaches the rep', () => {
    const out = repairPayLink('Share this with your students: https://duevy.com/duevy.app/d/cmw650v3k00048olwm5j9zn1h', null);
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain('cmw650v3k00048olwm5j9zn1h');
  });

  it('strips a scheme-less wrong link and markdown/placeholder links', () => {
    expect(repairPayLink('here: duevy.com/d/abc123', null)).not.toContain('duevy.com/d/');
    expect(repairPayLink('tap [Link to pay] now', null)).not.toMatch(/\[Link to pay\]/i);
    expect(repairPayLink('see [here](https://x.y/pay/z)', null)).not.toContain('x.y');
  });
});

describe('looksLikeFabricatedLive — detect an invented "due is live" reply', () => {
  const transcript1 = "🎉 You're live! CSC 202 Manual is open for payment. Share this: https://duevy.com/due/cmw650v3k00048olwm5j9zn1h";
  const transcript2 = "🎉 You're live! INS 305 HANDOUT is open for payment. Share this with your students: https://duevy.com/duevy.app/d/cmw650v3k00048olwm5j9zn1h";

  it('flags both real faulty transcripts when no tool link was produced', () => {
    expect(looksLikeFabricatedLive(transcript1, null)).toBe(true);
    expect(looksLikeFabricatedLive(transcript2, null)).toBe(true);
  });

  it('does NOT flag when a real pay link was produced this turn', () => {
    expect(looksLikeFabricatedLive(transcript2, REAL)).toBe(false);
  });

  it('does NOT flag an honest no-link reply, or a success claim with no link shown', () => {
    expect(looksLikeFabricatedLive("I couldn't create that due just now — want me to try again?", null)).toBe(false);
    // Claims live but shows no link/placeholder at all: not the fabricated-link pattern.
    expect(looksLikeFabricatedLive("Your due is now live.", null)).toBe(false);
  });

  it('does NOT flag unrelated replies that merely contain a URL', () => {
    expect(looksLikeFabricatedLive('Our help centre is at duevy.app/help', null)).toBe(false);
  });
});
