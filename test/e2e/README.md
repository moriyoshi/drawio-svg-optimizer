# Native font back-ends, end to end

`src/fonts/native/fontconfig.ts` and `src/fonts/native/directwrite.ts` read the
platform font registry through a native library. A macOS checkout cannot
execute a line of either. This harness runs both against real ones, in one
Docker image.

```sh
npm run test:e2e:fonts            # both halves
npm run test:linux                # fontconfig only
npm run test:windows              # DirectWrite under Wine only
./test/e2e/run.sh --rebuild       # force a fresh image
```

Exits non-zero if a probe fails, and prints a JSON report either way.

## One image

The two halves used to have an image each. They share one now, because the
expensive half — Wine, a Windows Node, a font directory assembled by hand — is
built on a Debian userland that is already everything the Linux half needs, and
because koffi picks its binary by `process.platform` when it is first required
rather than at install time. So one `node_modules` holding both prebuilds
answers a Linux process and a Wine process out of the same layer, and
`entrypoint.sh` chooses which to start.

The price is that the whole image is `linux/amd64`, since koffi's Windows
prebuild is x64 and an arm64 Wine would have nothing to load. On Apple Silicon
the Linux half therefore runs emulated too — a few seconds rather than
instant, and the arm64 koffi prebuild no longer gets exercised. That prebuild's
correctness is koffi's business rather than this project's, and both x86-64 and
aarch64 are LP64, so nothing about the bindings goes untested. Two images was
the higher price.

## Windows: what a pass does and does not prove

DirectWrite is COM. Every call is a vtable slot index — a bare number that
nothing type-checks — and an index wrong by one calls a different method
through a mismatched prototype. That does not raise; it corrupts memory.

Wine closes the gap. It implements `dwrite.dll` and runs the Windows build of
Node, so inside that process `process.platform` is `win32`, koffi loads its
win32 prebuild, and `koffi.load('dwrite.dll')` resolves to Wine's
implementation — the same path a real Windows user takes.

**A pass proves** the parts that corrupt memory when wrong: the slot indices
line up with a real `dwrite.dll`, prototypes match the methods they call, the
`__stdcall` convention is right, the `IDWriteLocalFontFileLoader` chain reaches
a file path, and `FindFamilyName` reports an absent family through its `exists`
out-parameter rather than inventing a substitute.

**It does not prove** that behaviour matches Microsoft's DirectWrite in every
detail. Wine is an independent implementation. Font *enumeration* in particular
depends on what the image installs, so the families found here say nothing
about what a real Windows machine has.

## Linux: cheaper, and worth saying why

fontconfig is a flat C API, so there are no slot indices to get wrong, no
calling convention to declare, and no emulation of the platform — this *is* the
platform, running the same compiled back-end a Linux user would. The sharp
edges are ownership and the weight scale, and the probe checks both.

It is also the only half that can compare the two font tiers directly. The
probe runs the **scanner** — `loadFontBackend({ native: false })` — against the
same fonts and asserts that neither tier is empty where the other is not,
rather than that their face counts match: the registry legitimately sees faces
a directory walk cannot, and that difference is the whole argument for the
native tier. What must not happen is the fallback quietly finding nothing. The
Windows half skips this, because under Wine the directory the scanner would
walk is the one the image assembled by hand — agreement there would prove
nothing the registry half has not.

## What the probe asserts

Checks run in dependency order and stop at the first failure. "No fonts found"
otherwise cannot distinguish a missing library from an empty font cache from a
wrong slot index, and those need very different fixes.

Each half starts by enumerating the registry through a route that is **not** the
code under test — `FcFontList` directly on Linux, `GetFontFamilyCount` and
`GetFontFamily` on Windows rather than the back-end's `FindFamilyName`. Zero
families there means the image has no fonts; families there that the back-end
then cannot find means the back-end is at fault. Everything after that is shared
between the two, because both back-ends implement the same interface:

- **At least one candidate family resolves**, from a list of what the image
  installs rather than a hard-coded name a Wine or Debian upgrade could take
  away.
- **Faces carry a real font-file path**, reached on Windows through the
  `IDWriteLocalFontFileLoader` chain.
- **Weight is on the CSS scale.** fontconfig calls regular 80 and bold 200, not
  400 and 700; a face escaping with a fontconfig-scale weight would make every
  downstream comparison wrong while still looking like a plausible number. So
  anything outside 100–1000 is rejected and a bold face must report exactly
  700. DirectWrite is already on that scale, so it holds there for free.
- **Slant is a boolean**, and a face whose filename says italic reports one.
- **An uninstalled family returns nothing.** Neither back-end may substitute:
  `FcFontList` selects rather than matching — unlike `FcFontMatch`, and unlike
  the `fc-match` subprocess it replaces, which always answered with *something*
  and needed a guard against its own helpfulness — and `FindFamilyName` reports
  absence through an out-parameter that is easy to misread.
- **Repeated lookups stay stable.** Both back-ends own something they must
  release — an `FcFontSet` here, a COM reference there. If that ownership were
  wrong, the second identical call is where a use-after-free would surface.

## Fonts

The image installs Liberation and DejaVu, and copies them into
`drive_c/windows/Fonts` for the Wine side. A bare prefix has almost nothing to
enumerate, and a font registry with no fonts in it proves nothing either way.

## Things that cost time, so they are written down

Each of these produced a failure that looked like a bug in a back-end.

**`wineboot` registers only Wine's built-in `.fon` bitmaps.** TrueType files
copied into the font directory are invisible to DirectWrite until they are
registered under `HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts`,
the way Windows does it. Without that step `GetSystemFontCollection` succeeds
and reports **zero families**, even with fontconfig resolving every face and
`fc-match "Liberation Sans"` answering correctly. This was the single biggest
time sink here, because it looks exactly like a broken back-end.

**Font setup must precede `wineboot --init`.** Wine builds its font list when
the prefix is created. Fonts copied in afterwards are not picked up, and
`wineboot -u` does not rescan them.

**`fontconfig`, not just `libfontconfig1`.** The library alone reports nothing
until a cache exists, and `fc-cache` ships in the tools package. This bites
both halves: Wine also enumerates Unix fonts through fontconfig, and with no
cache its font list comes up empty too.

**Wine 11 cannot run under x86-64 emulation on Apple Silicon.** Every Windows
program dies with `could not load kernel32.dll, status c0000135`, reproducible
in unrelated Wine 11 images, so it is not a packaging problem. Debian's Wine 8
runs fine emulated, which is why the image uses it. On a native x86-64 host
WineHQ's newer builds are preferable — and note that WineHQ needs both
`dpkg --add-architecture i386` and `--install-recommends`, or it installs
cleanly and then cannot load `kernel32.dll` either.

**A broken prefix must fail the build.** The image ends its Wine setup with
`wine cmd /c "exit 0"`, because every prefix problem above is silent at install
time and only appears when a program runs.

**No X server is required.** `wine cmd /c echo hi` works headless and `node.exe`
starts without a display. An earlier version of this image installed `xvfb` and
wrapped everything in `xvfb-run`; it was pure cost.

**Node cannot write to stdout under Wine.** `process.stdout` throws
`EBADF: open` before a byte is emitted, whatever the display situation. The
probe writes `report-<target>.json` and the entrypoint reads it back from the
Linux side; exit status comes from the report's own `ok` field, which also
avoids depending on Wine to propagate one. The Linux half reports the same way
so that there is one output path rather than two.

**koffi resolves a function by the name in its prototype.** Declaring
`DWriteCreateFactory2` to dodge a redeclaration makes koffi look for a symbol
literally called that. Declare once and reuse the handle.

**Node's Windows build refuses to start below Windows 8.1**, and Wine defaults
to reporting Windows 7. The prefix is set to `win10`, with
`NODE_SKIP_PLATFORM_CHECK=1` as a second line of defence.

**`_Out_ char**`, not `_Out_ void**`, for `FcPatternGetString`.** Declaring the
out parameter as `char**` makes koffi marshal the string itself. Taking the raw
pointer and decoding it afterwards segfaults, because koffi reads a `str` as a
pointer *to* a string and dereferences one level too far.
