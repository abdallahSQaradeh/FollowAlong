# Fixing MP4 sound

Type: grilling
Status: open
Blocked by: 01

## Question

VS Code plays the Course MP4s' H.264 video but their AAC audio is silent (see [research/01-video-playback.md](../research/01-video-playback.md)). Which fix does FollowAlong use?
- a separate audio file made once per Lesson with ffmpeg (MP3/Vorbis) and kept in sync with the muted video (~10 GB extra for the whole library)
- a one-time rewrite of each MP4 with MP3 audio (simpler, up to ~62 GB extra)
- an AAC decoder in WebAssembly inside the player (no ffmpeg, harder to build)

Also: is it acceptable for FollowAlong to need an ffmpeg binary, and does the conversion happen per Lesson when first opened, or for the whole Course when it's opened?
