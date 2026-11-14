# Can VS Code play the Course videos?

Type: research
Status: resolved
Blocked by: none

## Question

Can a VS Code extension webview play the learner's local Lesson videos (`.mp4`, most likely H.264/AAC, and `.webm`) with reliable seek, pause, and playback-rate control? VS Code's Electron build is known to ship with limited media codecs. If H.264 doesn't play, which fallback is viable: transcoding on first open (ffmpeg), driving an external player such as mpv over IPC from the extension, or something else? Also: which codecs do the actual files in `D:\Learning` use (sample with ffprobe)?

## Answer

Partly. In a webview (VS Code 1.146, tested), H.264 video plays with working seek, pause, playbackRate and range requests. But **AAC audio is silent**, and all 324 Course MP4s are H.264 + AAC. VS Code ships no AAC decoder for licensing reasons (microsoft/vscode#156558, #167685 open, #343048). The 114 WebMs (VP8 + Vorbis) fail as `<video src>` but **play with sound via MediaSource**. Recommended: webview player, MSE for WebM, and for MP4 an ffmpeg-made audio sidecar (MP3/Vorbis) synced to the muted video, or a remux to MP3 audio. mpv breaks the no-Focus-change goal. A local HTTP server alone doesn't help. ffprobe/ffmpeg are not installed; codecs were read from container headers.

Details: [research/01-video-playback.md](../research/01-video-playback.md)
