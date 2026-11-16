# BicuSlicer: web front end for the OrcaSlicer CLI.
# Built on the linuxserver OrcaSlicer image so the slicer binary and its libraries come ready-made
# (and, if you also run that image for the desktop app, the layers are shared on disk).
# Match this tag to your desktop OrcaSlicer version so presets load in both.
FROM lscr.io/linuxserver/orcaslicer:v2.5.1-ls51

COPY app /app
ENTRYPOINT []
WORKDIR /app
ENV PYTHONUNBUFFERED=1
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD /lsiopy/bin/python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/presets', timeout=4)"
CMD ["/lsiopy/bin/python3", "/app/server.py"]
