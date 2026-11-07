import { randomUUID } from 'crypto';
import ImageKit, { toFile } from '@imagekit/nodejs';
import { env } from '../../config/env';

/**
 * Private file storage for KYC documents. Files are never public: they are
 * uploaded as private and only ever handed out as short-lived signed URLs to
 * an admin reviewing them. Only the returned reference is stored in our
 * database.
 */
export interface StoredFile {
  fileId: string;
  filePath: string;
}

export interface UploadInput {
  buffer: Buffer;
  fileName: string;
  /** Folder under IMAGEKIT_KYC_FOLDER, e.g. "student-id/usr_123". */
  folder: string;
  tags?: string[];
}

export interface PrivateFileStore {
  readonly name: string;
  upload(input: UploadInput): Promise<StoredFile>;
  /** A URL that works for `expiresInSeconds`, then stops. */
  signedUrl(filePath: string, expiresInSeconds: number): string;
  delete(fileId: string): Promise<void>;
}

class ImageKitStore implements PrivateFileStore {
  readonly name = 'imagekit';
  private readonly client: ImageKit;

  constructor(
    privateKey: string,
    private readonly urlEndpoint: string,
    private readonly root: string,
  ) {
    this.client = new ImageKit({ privateKey });
  }

  async upload(input: UploadInput): Promise<StoredFile> {
    const res = await this.client.files.upload({
      file: await toFile(input.buffer, input.fileName),
      fileName: input.fileName,
      folder: `${this.root.replace(/\/$/, '')}/${input.folder}`,
      isPrivateFile: true,
      useUniqueFileName: true,
      tags: input.tags,
    });
    if (!res.fileId || !res.filePath) throw new Error('ImageKit upload returned no file reference');
    return { fileId: res.fileId, filePath: res.filePath };
  }

  signedUrl(filePath: string, expiresInSeconds: number): string {
    return this.client.helper.buildSrc({ urlEndpoint: this.urlEndpoint, src: filePath, signed: true, expiresIn: expiresInSeconds });
  }

  async delete(fileId: string): Promise<void> {
    await this.client.files.delete(fileId);
  }
}

/** In-memory store for tests and local development. Refused in production. */
export class MemoryFileStore implements PrivateFileStore {
  readonly name = 'memory';
  readonly files = new Map<string, { filePath: string; buffer: Buffer; tags?: string[] }>();

  async upload(input: UploadInput): Promise<StoredFile> {
    const fileId = `mem_${randomUUID()}`;
    const filePath = `/${input.folder}/${fileId}-${input.fileName}`;
    this.files.set(fileId, { filePath, buffer: input.buffer, tags: input.tags });
    return { fileId, filePath };
  }

  signedUrl(filePath: string, expiresInSeconds: number): string {
    return `memory://${filePath}?expires=${Math.floor(Date.now() / 1000) + expiresInSeconds}`;
  }

  async delete(fileId: string): Promise<void> {
    this.files.delete(fileId);
  }
}

let instance: PrivateFileStore | null = null;

export function getFileStore(): PrivateFileStore {
  if (instance) return instance;
  instance =
    env.FILE_STORAGE === 'memory'
      ? new MemoryFileStore()
      : new ImageKitStore(env.IMAGEKIT_PRIVATE_KEY as string, env.IMAGEKIT_URL_ENDPOINT as string, env.IMAGEKIT_KYC_FOLDER);
  return instance;
}

/** Test seam. */
export function setFileStore(store: PrivateFileStore | null): void {
  instance = store;
}

// ---------------------------------------------------------------------------
// Public images: avatars and poll images. Uploaded as public files and served
// straight from ImageKit's CDN, so every API instance sees the same files and
// none of them pass through the API (they used to sit on one container's disk
// under /uploads, which a second instance couldn't see).
// ---------------------------------------------------------------------------

export interface PublicImage {
  fileId: string;
  /** Absolute https URL, safe to store and hand to browsers. */
  url: string;
}

export interface PublicImageUploadInput {
  buffer: Buffer;
  fileName: string;
  /** Folder under IMAGEKIT_PUBLIC_FOLDER, e.g. "avatars". */
  folder: string;
  tags?: string[];
}

export interface PublicImageStore {
  readonly name: string;
  upload(input: PublicImageUploadInput): Promise<PublicImage>;
  delete(fileId: string): Promise<void>;
}

class ImageKitPublicStore implements PublicImageStore {
  readonly name = 'imagekit';
  private readonly client: ImageKit;

  constructor(
    privateKey: string,
    private readonly root: string,
  ) {
    this.client = new ImageKit({ privateKey });
  }

  async upload(input: PublicImageUploadInput): Promise<PublicImage> {
    const res = await this.client.files.upload({
      file: await toFile(input.buffer, input.fileName),
      fileName: input.fileName,
      folder: `${this.root.replace(/\/$/, '')}/${input.folder}`,
      isPrivateFile: false,
      useUniqueFileName: true,
      tags: input.tags,
    });
    if (!res.fileId || !res.url) throw new Error('ImageKit upload returned no file reference');
    return { fileId: res.fileId, url: res.url };
  }

  async delete(fileId: string): Promise<void> {
    await this.client.files.delete(fileId);
  }
}

/** In-memory public store for tests and local development. Refused in production. */
export class MemoryPublicImageStore implements PublicImageStore {
  readonly name = 'memory';
  readonly files = new Map<string, { url: string; buffer: Buffer; tags?: string[] }>();

  async upload(input: PublicImageUploadInput): Promise<PublicImage> {
    const fileId = `mem_${randomUUID()}`;
    const url = `https://images.memory.invalid/${input.folder}/${fileId}-${input.fileName}`;
    this.files.set(fileId, { url, buffer: input.buffer, tags: input.tags });
    return { fileId, url };
  }

  async delete(fileId: string): Promise<void> {
    this.files.delete(fileId);
  }
}

let publicInstance: PublicImageStore | null = null;

export function getPublicImageStore(): PublicImageStore {
  if (publicInstance) return publicInstance;
  publicInstance =
    env.FILE_STORAGE === 'memory'
      ? new MemoryPublicImageStore()
      : new ImageKitPublicStore(env.IMAGEKIT_PRIVATE_KEY as string, env.IMAGEKIT_PUBLIC_FOLDER);
  return publicInstance;
}

/** Test seam. */
export function setPublicImageStore(store: PublicImageStore | null): void {
  publicInstance = store;
}

// ---------------------------------------------------------------------------
// Upload validation: never trust the client's filename or Content-Type.
// ---------------------------------------------------------------------------

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: 'image/jpeg', ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/png', ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: 'image/webp', ext: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mime: 'application/pdf', ext: 'pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

/** The file's real type from its first bytes, or null if it isn't an accepted document type. */
export function sniffDocumentType(buffer: Buffer): { mime: string; ext: string } | null {
  const hit = SIGNATURES.find((s) => buffer.length >= 12 && s.test(buffer));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

// ---------------------------------------------------------------------------
// Liveness captures: a photo or a short video of the rep's face, recorded by
// the app. Same rule: the type comes from the bytes, never the client.
// ---------------------------------------------------------------------------

/** Short selfie videos from a phone or browser fit comfortably; photos are far smaller. */
export const MAX_LIVENESS_BYTES = 15 * 1024 * 1024;

/** ISO-BMFF brands that are still images (HEIC/AVIF), not video, despite the same container. */
const STILL_IMAGE_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);

/** A liveness capture's real type: JPEG/PNG/WebP photo or MP4/MOV/WebM video. Null otherwise. */
export function sniffLivenessType(buffer: Buffer): { mime: string; ext: string; kind: 'photo' | 'video' } | null {
  const doc = sniffDocumentType(buffer);
  if (doc && doc.mime.startsWith('image/')) return { ...doc, kind: 'photo' };
  if (buffer.length < 12) return null;
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('latin1');
    if (STILL_IMAGE_BRANDS.has(brand)) return null;
    return brand === 'qt  ' ? { mime: 'video/quicktime', ext: 'mov', kind: 'video' } : { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  }
  // EBML header: WebM (what browsers' MediaRecorder produces) / Matroska.
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { mime: 'video/webm', ext: 'webm', kind: 'video' };
  }
  return null;
}
