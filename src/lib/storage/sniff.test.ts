import { describe, expect, it } from 'vitest';
import { sniffDocumentType } from './index';

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
