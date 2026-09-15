# Fly Radio: CPU only. Deploy with radio/deploy.sh, which stages a small build context
# (flytalk.py and radio/) and builds remotely. Mirrors flybook/worker/Dockerfile.
FROM python:3.12-slim

WORKDIR /app
COPY radio/requirements.txt radio/requirements.txt
RUN pip install --no-cache-dir -r radio/requirements.txt

# The brain files (~260 MB) come from the flybrain data release, sha256-checked, fetched once
# at build time so machines start without downloading anything.
ENV FLY_DATA=/data PYTHONUNBUFFERED=1
RUN flybrain download

COPY flytalk.py ./
COPY radio/*.py radio/site.html radio/
COPY radio/model radio/model

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

CMD ["python", "radio/server.py", "--host", "0.0.0.0", "--no-browser"]
