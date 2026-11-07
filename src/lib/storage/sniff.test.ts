import { describe, expect, it } from 'vitest';
import { sniffDocumentType, sniffLivenessType } from './index';

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(16)]);

describe('sniffDocumentType', () => {
  it('recognises JPEG, PNG, WebP and PDF by their bytes', () => {
    expect(sniffDocumentType(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))?.mime).toBe('image/jpeg');
    expect(sniffDocumentType(pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))?.mime).toBe('image/png');
    expect(sniffDocumentType(pad(Buffer.from('RIFF\0\0\0\0WEBP', 'latin1')))?.mime).toBe('image/webp');
    expect(sniffDocumentType(pad(Buffer.from('%PDF-1.7', 'latin1')))?.ext).toBe('pdf');
  });

  it('rejects anything else, whatever it is called', () => {
    expect(sniffDocumentType(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')))).toBeNull();
    expect(sniffDocumentType(pad(Buffer.from('GIF89a')))).toBeNull();
    expect(sniffDocumentType(Buffer.from([0xff, 0xd8]))).toBeNull(); // truncated
  });
});


describe('sniffLivenessType', () => {
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(32)]);
  it('accepts photos and phone/browser videos by their bytes', () => {
    expect(sniffLivenessType(pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0])))?.kind).toBe('photo');
    expect(sniffLivenessType(pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom')]))) ).toMatchObject({ mime: 'video/mp4', kind: 'video' });
    expect(sniffLivenessType(pad(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ')]))) ).toMatchObject({ mime: 'video/quicktime', ext: 'mov' });
    expect(sniffLivenessType(pad(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))).toMatchObject({ mime: 'video/webm', kind: 'video' });
  });
  it('refuses PDFs, HEIC stills and anything else', () => {
    expect(sniffLivenessType(pad(Buffer.from('%PDF-1.7')))).toBeNull();
    expect(sniffLivenessType(pad(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')])))).toBeNull();
    expect(sniffLivenessType(pad(Buffer.from('<html><script>')))).toBeNull();
  });
});
