# One image, both native font registries.
#
# `src/fonts/native/fontconfig.ts` and `src/fonts/native/directwrite.ts` are the
# two back-ends a macOS checkout cannot execute a line of. They used to have an
# image each. They share one now, because the expensive half of the Windows
# image — Wine, a Windows Node, a populated font directory — is built on a
# Debian userland that is already everything the Linux harness needs, and koffi
# picks its binary by `process.platform` at run time rather than at install
# time. So a single `node_modules` with both prebuilds serves a Linux process
# and a Wine process out of the same layer.
#
# What each half is for:
#
# **DirectWrite** is COM. Every call is a vtable slot index that nothing
# verifies, and an index wrong by one calls a different method through a
# mismatched prototype — which does not raise, it corrupts memory. Wine
# implements dwrite.dll and runs the Windows build of Node, so `process.platform`
# is `win32`, koffi loads its win32 prebuild, and the compiled back-end takes
# the same path a real Windows user would. Wine is not Windows: a pass proves
# the slot indices, prototypes and calling convention line up with a real
# DirectWrite implementation, not that behaviour matches Microsoft's in detail.
#
# **fontconfig** is a flat C API on the platform the container already is, so
# that half needs no emulation layer at all — it is the real library, running
# the real compiled back-end, the way a Linux user would.
#
# The whole image is linux/amd64 because koffi's Windows prebuild is x64 and an
# arm64 Wine would have nothing to load. On Apple Silicon that means the Linux
# half runs emulated too, which costs a few seconds of run time and the arm64
# koffi prebuild's coverage. Two images was the higher price.

# ---------------------------------------------------------------------------
# Fetch koffi's *Windows* binary from a Linux builder.
#
# npm's --os/--cpu overrides exist precisely for this: resolve optional
# dependencies for a platform that is not the one doing the installing.
# --ignore-scripts keeps koffi's cnoke build step from running, which is
# correct — we want the prebuilt binary, not a compile.
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-bookworm-slim AS winkoffi

ARG KOFFI_VERSION=3.2.1
WORKDIR /stage
RUN npm init -y > /dev/null \
 && npm install --os=win32 --cpu=x64 --ignore-scripts "koffi@${KOFFI_VERSION}"

# ---------------------------------------------------------------------------
# The harness: a Linux Node (from the base image), a Windows Node under Wine,
# and one font set that both of them see.
# ---------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-bookworm-slim

ARG NODE_VERSION=22.11.0
ARG KOFFI_VERSION=3.2.1

ENV DEBIAN_FRONTEND=noninteractive \
    WINEPREFIX=/wine \
    WINEDEBUG=-all \
    WINEDLLOVERRIDES=mscoree=d \
    # Node refuses to start when the reported Windows version is below 8.1.
    # The prefix is configured to report Windows 10 below, which is the real
    # fix; this is here because the check also consults the build number, and a
    # Wine upgrade changing that should not silently break the harness.
    NODE_SKIP_PLATFORM_CHECK=1

# Debian's Wine, not WineHQ's.
#
# This is a compromise forced by the host. WineHQ's Wine 11 has the better
# DirectWrite, but it cannot run a Windows program at all under Docker's
# x86-64 emulation on Apple Silicon — `could not load kernel32.dll, status
# c0000135`, reproducible in unrelated Wine 11 images too. Debian's Wine 8 runs
# fine under emulation. On a native x86-64 host, prefer WineHQ.
#
# `fontconfig` — the tools package, not just `libfontconfig1` — earns its place
# twice over. Wine enumerates fonts on Unix through fontconfig and comes up
# empty without a cache, and the fontconfig back-end is the other half of what
# this image tests. The font packages are that back-end's subject matter: a
# font registry with no fonts in it proves nothing either way.
#
# No X server is needed: Wine runs console programs headless, and node.exe
# starts without a display.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      wine wine64 ca-certificates curl unzip \
      libfontconfig1 fontconfig \
      fonts-liberation fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/node.zip \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip" \
 && unzip -q /tmp/node.zip -d /opt \
 && mv "/opt/node-v${NODE_VERSION}-win-x64" /opt/node-win \
 && rm /tmp/node.zip

# Order matters. The fontconfig cache and the Windows font directory must both
# be populated *before* the prefix is initialised: Wine builds its font list
# during wineboot, and fonts added afterwards are not picked up — `wineboot -u`
# does not rescan them either.
RUN fc-cache -f > /dev/null

RUN mkdir -p "${WINEPREFIX}/drive_c/windows/Fonts" \
 && cp /usr/share/fonts/truetype/liberation/*.ttf "${WINEPREFIX}/drive_c/windows/Fonts/" \
 && cp /usr/share/fonts/truetype/dejavu/*.ttf "${WINEPREFIX}/drive_c/windows/Fonts/"

# No error suppression, and an explicit smoke test: a prefix that cannot run
# `cmd` must fail the build here rather than produce a mystery at run time.
RUN wineboot --init && wineserver -w && wine cmd /c "exit 0"

# Debian's Wine defaults to reporting Windows 7, and Node's Windows build exits
# immediately on anything below 8.1.
RUN wine reg add 'HKCU\Software\Wine' /v Version /t REG_SZ /d win10 /f && wineserver -w

# Register each face under the key Windows uses. `wineboot` only registers
# Wine's built-in `.fon` bitmaps, so without this the font directory is full of
# TrueType files that nothing has been told about.
RUN for f in "${WINEPREFIX}"/drive_c/windows/Fonts/*.ttf; do \
      name=$(basename "$f" .ttf); \
      wine reg add 'HKLM\Software\Microsoft\Windows NT\CurrentVersion\Fonts' \
        /v "$name (TrueType)" /t REG_SZ /d "$(basename "$f")" /f > /dev/null 2>&1 || true; \
    done; wineserver -w

WORKDIR /app

# koffi for the *host* here — linux/x64, since that is what this image is. The
# win32 binary arrives below, and the two coexist: koffi resolves
# `@koromix/koffi-${process.platform}-${process.arch}` when it is first
# required, so the same directory answers both processes.
#
# `font-finder` and `get-system-fonts` back the scanner tier, which the Linux
# probe exercises alongside the registry so the two can be compared on one
# machine.
RUN npm init -y > /dev/null \
 && npm install --silent --ignore-scripts \
      "koffi@${KOFFI_VERSION}" font-finder get-system-fonts

COPY --from=winkoffi /stage/node_modules/@koromix ./node_modules/@koromix

COPY dist ./dist
COPY test/e2e/probe.mjs ./probe.mjs
COPY test/e2e/entrypoint.sh ./entrypoint.sh

# Which halves to run: `linux`, `windows`, or `both`.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["both"]
