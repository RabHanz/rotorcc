# Hook payload fixtures

Every file here is the shape of a real hook payload, captured from a running
Claude Code 2.1.x by a probe hook that wrote its stdin to disk. The field names,
nesting and optionality are exactly as observed — nothing here was inferred from
documentation.

Paths, session ids and directory names have been replaced with neutral ones. The
structure is the fixture; the machine they came from is not.

Capture method, if you want to redo it on a newer release:

1. Write a script that reads stdin and appends it to a file, and exits 0.
2. Point every hook event at it in a throwaway settings file.
3. Run one session with `--settings <that file>`, make it call a tool and launch
   a subagent, then `/compact` it and exit.
4. The files it wrote are the payloads.
