# The quiet period setting has a flat name: `followalong.autoPauseResumeAfter`

Spec #12 and ticket #60 name the quiet period of `pauseAndResume` `followalong.autoPause.resumeAfter`,
beside the string setting `followalong.autoPause`. VS Code cannot hold both. It builds the settings
into a tree of objects, and a key that continues a key holding a string is dropped, with only a log
line (`Ignoring followalong.autoPause.resumeAfter as followalong.autoPause is "off"`,
`addToValueTree` in `src/vs/platform/configuration/common/configuration.ts`). The smoke test showed
it on VS Code 1.146.0 (CI run 43960506713, Ubuntu job): the setting had no default (`undefined !==
2`); the Windows smoke job of that run failed as well. So the quiet period is `followalong.autoPauseResumeAfter` (seconds, default
2; any number above 0, else 2). The orchestrator ruled this on the #60 plan, as the routed note on
#60 allowed.

## Considered Options

- **An object setting `followalong.autoPause` (`{mode, resumeAfter}`)**: one name, but the Settings
  editor shows an object as "Edit in settings.json", and #59 has shipped the string.
- **Renaming the mode (`followalong.autoPause.mode`)**: frees the prefix, but breaks the setting
  #59 shipped, and #61's toggle writes it.

## Consequences

- The two settings stay apart in VS Code's change events too: `affectsConfiguration` matches by
  prefix with a dot, so a change of the quiet period is no longer reported as a change of
  `autoPause`. The Loaded Lesson still reads each setting on its own.
- The smoke test checks that both settings register with their defaults and read back what the
  learner set, so a later name that clashes fails there.
