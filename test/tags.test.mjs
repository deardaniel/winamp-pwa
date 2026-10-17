import { test } from "node:test";
import assert from "node:assert/strict";
import { openAsBlob } from "node:fs";
import { readTags, groupAlbums } from "../tags.js";

const fx = n => openAsBlob(new URL(`./fixtures/${n}`, import.meta.url));

test("ID3v2.3 tags, cover and exact gapless length", async () => {
  const t = await readTags(await fx("p2.mp3"));
  assert.equal(t.title, "Part 2");
  assert.equal(t.artist, "Sine & Co");
  assert.equal(t.albumArtist, "Test Artist");
  assert.equal(t.album, "Gap Test");
  assert.equal(t.track, 2);
  assert.equal(t.disc, 1);
  assert.equal(t.year, 1999);
  assert.equal(t.picture.mime, "image/jpeg");
  assert.deepEqual([...t.picture.data.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal(t.sampleRate, 44100);
  assert.equal(t.bitrate, 192); // CBR ("Info" header): the nominal rate, not an average
  assert.equal(t.gapless, true);
  assert.equal(Math.round(t.duration * 44100), 183332); // the sample count the decoder produces
});

test("ID3v2.4 UTF-8 Japanese", async () => {
  const t = await readTags(await fx("v24.mp3"));
  assert.equal(t.title, "テスト曲");
  assert.equal(t.artist, "アーティスト");
  assert.equal(t.album, "アルバム");
  assert.equal(t.track, 7);
});

test("untagged CBR file still gets a duration", async () => {
  const t = await readTags(await fx("bare.mp3"));
  assert.equal(t.title, null);
  assert.equal(t.album, null);
  assert.equal(t.gapless, false);
  assert.ok(Math.abs(t.duration - 150001 / 44100) < 0.1, `duration ${t.duration}`);
});

test("Shift-JIS in a latin1-labelled frame, and ID3v1 fallback", async () => {
  const sjis = [0x83, 0x65, 0x83, 0x58, 0x83, 0x67]; // テスト
  const frame = (id, body) => [...Buffer.from(id), 0, 0, 0, body.length + 1, 0, 0, 0, ...body];
  const body = [...frame("TIT2", sjis), ...frame("TALB", [...Buffer.from("Caf\xe9", "latin1")])];
  const tag = [...Buffer.from("ID3"), 3, 0, 0, 0, 0, 0, body.length, ...body];
  const v1 = Buffer.alloc(128);
  v1.write("TAG"); v1.write("ignored title", 3); v1.write("V1 Artist", 33); v1[126] = 9;
  const audio = Buffer.from(await (await fx("bare.mp3")).arrayBuffer());
  const t = await readTags(new Blob([Buffer.from(tag), audio, v1]));
  assert.equal(t.title, "テスト");
  assert.equal(t.album, "Café");
  assert.equal(t.artist, "V1 Artist");
  assert.equal(t.track, 9);
});

test("albums are grouped and ordered by tags, not names", () => {
  const T = (o, i) => ({ id: String(i), fileName: `zz${9 - i}.mp3`, duration: 60, ...o });
  const albums = groupAlbums([
    T({ album: "Live", albumArtist: "Band", artist: "Band", track: 2, title: "B" }, 0),
    T({ album: "Live", albumArtist: "Band", artist: "Band feat. X", track: 1, title: "A" }, 1),
    T({ album: "Live", albumArtist: "Band", artist: "Band", disc: 2, track: 1, title: "C" }, 2),
    T({ album: "Hits", artist: "One", track: 1, title: "o1" }, 3),
    T({ album: "Hits", artist: "Two", track: 1, title: "t1" }, 4),
    T({ album: "Mix", artist: "P", track: 1 }, 5),
    T({ album: "Mix", artist: "Q", track: 2 }, 6),
    T({ artist: "Solo", title: "loose" }, 7),
  ]);
  const by = Object.fromEntries(albums.map(a => [`${a.artist}/${a.title}`, a.tracks.map(t => t.id).join("")]));
  assert.deepEqual(by, {
    "Band/Live": "102",
    "One/Hits": "3",
    "Two/Hits": "4",
    "Various Artists/Mix": "56",
    "Solo/Unknown Album": "7",
  });
});
