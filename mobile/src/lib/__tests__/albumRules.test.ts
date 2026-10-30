import { describe, expect, it } from 'vitest';
import {
  addedLine,
  albumContentType,
  albumExt,
  albumPath,
  albumRoom,
  albumToken,
  orderAlbum,
} from '../albumRules';

describe('album paths', () => {
  it('puts the file in the album folder, under the uploader', () => {
    expect(albumPath('event', 'E1', 'U1', 'tok', 'JPEG')).toBe('event/E1/U1/tok.jpg');
    expect(albumPath('tournament', 'T1', 'U1', 'tok', 'heic')).toBe('tournament/T1/U1/tok.heic');
  });
  it('keeps extensions the bucket takes, else jpg', () => {
    expect(albumExt('PNG')).toBe('png');
    expect(albumExt('gif')).toBe('jpg');
    expect(albumExt(undefined)).toBe('jpg');
    expect(albumContentType('jpg')).toBe('image/jpeg');
    expect(albumContentType('webp')).toBe('image/webp');
  });
  it('makes path-safe tokens', () => {
    expect(albumToken(() => 0.5)).toMatch(/^[a-z0-9]+$/);
  });
});

describe('room left', () => {
  it('counts down from 4', () => {
    expect(albumRoom(0)).toEqual({ left: 4, pick: 4 });
    expect(albumRoom(3)).toEqual({ left: 1, pick: 1 });
    expect(albumRoom(4)).toEqual({ left: 0, pick: 0 });
    expect(albumRoom(6)).toEqual({ left: 0, pick: 0 });
    expect(albumRoom(0, 20)).toEqual({ left: 20, pick: 4 });
  });
  it('words the result', () => {
    expect(addedLine(1, 1)).toBe('1 photo added');
    expect(addedLine(3, 3)).toBe('3 photos added');
    expect(addedLine(2, 3)).toBe('Added 2 of 3 photos');
  });
});

describe('orderAlbum', () => {
  it('oldest first, blocked players left out', () => {
    const photos = [
      { id: 'b', createdAt: '2026-10-02T00:00:00Z', uploaderId: 'U1' },
      { id: 'a', createdAt: '2026-10-01T00:00:00Z', uploaderId: 'U2' },
      { id: 'c', createdAt: '2026-10-03T00:00:00Z', uploaderId: 'X' },
    ];
    expect(orderAlbum(photos, new Set(['X'])).map((p) => p.id)).toEqual(['a', 'b']);
  });
});
