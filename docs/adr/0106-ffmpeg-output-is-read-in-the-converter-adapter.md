# ffmpeg's output is read in the Converter adapter, not the core

The CP3+CP4 architecture review (#12) asked whether the probe (`Input #0`, the first `Stream … Audio:`
line) and the progress parsing (`Duration:` and `time=`) should move into the core, so the recorded
exception D11 (the converter adapter test, `test/unit/ffmpeg-converter.test.ts`) would shrink. They
stay in `src/adapters/node/converter.ts`.

- **The Converter port speaks in the core's terms:** a sound codec or none, and a percentage.
  Reading ffmpeg's stderr is the translation an adapter exists for (CODING_STANDARDS, _Adapters stay
  thin_). Moving the parsing into the core would make the port carry raw ffmpeg lines, so the core
  would know one converter's output format, and a second converter would have to imitate it.
- **D11 would barely shrink.** Fewer than half of its 23 tests read ffmpeg's text. The rest cover what only
  the adapter can do: stopping and killing the process, the temp file and its sweep, error text
  without the temp file's name, and process priority. They need the faked process either way.
- **Pure parsers in the core called by the adapter** would be functions pulled out for testability,
  with the bugs still in how the adapter calls them. The adapter test already reaches them through
  the port with output recorded from a real ffmpeg (`test/fixtures/probe`).

Revisit if a second Converter adapter appears: two adapters make the port a real seam, and their
shared parsing would then earn a place of its own.
