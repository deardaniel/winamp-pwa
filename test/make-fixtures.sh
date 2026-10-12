#!/usr/bin/env bash
# Builds the test MP3s: one continuous 12 s sine cut into three tracks at
# sample positions that are deliberately not on MP3 frame boundaries.
set -euo pipefail
cd "$(dirname "$0")" && mkdir -p fixtures && cd fixtures

ffmpeg -v error -y -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=12" -ac 2 -c:a pcm_s16le full.wav
ffmpeg -v error -y -i full.wav -af "pan=mono|c0=FL" -f f32le full.raw
ffmpeg -v error -y -i full.wav -af "atrim=start_sample=0:end_sample=150001" p1.wav
ffmpeg -v error -y -i full.wav -af "atrim=start_sample=150001:end_sample=333333,asetpts=N/SR/TB" p2.wav
ffmpeg -v error -y -i full.wav -af "atrim=start_sample=333333,asetpts=N/SR/TB" p3.wav

# A tiny cover so the tag parser has a picture to find.
convert -size 64x64 gradient:orange-purple cover.jpg

for n in 1 2 3; do
  ffmpeg -v error -y -i p$n.wav -i cover.jpg -map 0:a -map 1:v -c:a libmp3lame -b:a 192k -c:v copy \
    -id3v2_version 3 -metadata title="Part $n" -metadata artist="Sine & Co" -metadata album_artist="Test Artist" \
    -metadata album="Gap Test" -metadata track="$n/3" -metadata disc="1/1" -metadata date="1999" p$n.mp3
done
# Same audio, tagged the awkward ways real files are: ID3v2.4 UTF-8 with Japanese, and no tags at all.
ffmpeg -v error -y -i p1.wav -c:a libmp3lame -q:a 4 -id3v2_version 4 \
  -metadata title="テスト曲" -metadata artist="アーティスト" -metadata album="アルバム" -metadata track="7" v24.mp3
ffmpeg -v error -y -i p1.wav -c:a libmp3lame -b:a 128k -map_metadata -1 -id3v2_version 0 -write_xing 0 bare.mp3
rm -f p?.wav
