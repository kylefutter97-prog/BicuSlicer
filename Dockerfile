# BicuSlicer: one self-contained image with OrcaSlicer's slicing engine and the web front end.
#
# OrcaSlicer comes from its official Linux AppImage for ORCA_VERSION, unpacked at build time
# (amd64 and arm64). It is the same program as the desktop app, run headless from the command
# line, so it still needs the GTK/WebKit/OpenGL libraries installed below even though no window
# ever opens. OrcaSlicer is AGPL-3.0: see THIRD_PARTY_NOTICES.md.
#
#   docker build -t bicuslicer .
#   docker build --build-arg ORCA_VERSION=2.5.1 -t bicuslicer .

ARG ORCA_VERSION=2.5.1

# ---------------------------------------------------------------- stage 1: unpack OrcaSlicer
FROM ubuntu:24.04 AS orca
ARG ORCA_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl squashfs-tools python3 \
 && rm -rf /var/lib/apt/lists/*
# The AppImage is an ELF launcher followed by a squashfs image. Unpack the squashfs directly (no FUSE,
# and no need to execute an arm64 binary when building on amd64): it starts where the ELF's section
# header table ends.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in amd64) arch="" ;; arm64) arch="_aarch64" ;; *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; esac; \
    curl -fsSL -o /tmp/orca.AppImage \
      "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/v${ORCA_VERSION}/OrcaSlicer_Linux_AppImage_Ubuntu2404${arch}_V${ORCA_VERSION}.AppImage"; \
    offset=$(python3 -c 'import struct,sys; h=open(sys.argv[1],"rb").read(64); shoff,=struct.unpack_from("<Q",h,0x28); shentsize,shnum=struct.unpack_from("<HH",h,0x3A); print(shoff+shentsize*shnum)' /tmp/orca.AppImage); \
    unsquashfs -q -offset "$offset" -dest /opt/orcaslicer /tmp/orca.AppImage; \
    rm /tmp/orca.AppImage; \
    test -x /opt/orcaslicer/bin/orca-slicer

# ---------------------------------------------------------------- stage 2: runtime
FROM ubuntu:24.04
ARG ORCA_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 python3-aiohttp \
      libgtk-3-0t64 libwebkit2gtk-4.1-0 libsoup-3.0-0 libsecret-1-0 \
      libgstreamer1.0-0 libgstreamer-plugins-base1.0-0 \
      libopengl0 libegl1 libgl1 libglx0 libdrm2 libwayland-egl1 libxkbcommon0 \
      libdbus-1-3 libfontconfig1 libmspack0 libsm6 libice6 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=orca /opt/orcaslicer /opt/orcaslicer
COPY app /app

ENV ORCA_BIN=/opt/orcaslicer/AppRun \
    DATA_DIR=/data \
    PYTHONUNBUFFERED=1 \
    ORCA_VERSION=${ORCA_VERSION}
LABEL org.opencontainers.image.title="BicuSlicer" \
      org.opencontainers.image.description="Phone-friendly web front end for the OrcaSlicer engine, for Klipper printers" \
      org.opencontainers.image.licenses="MIT AND AGPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/kylefutter97-prog/BicuSlicer"

# ubuntu:24.04 already has an unprivileged user with uid/gid 1000
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
WORKDIR /app
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/state', timeout=4)"
CMD ["python3", "/app/server.py"]
