## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux -> Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed -> AskUserQuestion with two options:
  1. **Docker (recommended)** -- description: "Cross-platform, better credential management, well-tested."
  2. **Apple Container (experimental)** -- description: "Native macOS runtime. Requires advanced setup."
  If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found -> Docker

### 3a-docker. Install Docker

- DOCKER=running -> continue to 4b
- DOCKER=installed_not_running -> start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found -> Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

Check if Docker is available:
```bash
docker info 2>/dev/null && echo "DOCKER_RUNNING" || (which docker 2>/dev/null && echo "DOCKER_INSTALLED" || echo "DOCKER_MISSING")
```

- **DOCKER_RUNNING** -> continue to step 3
- **DOCKER_INSTALLED** -> start it: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check.
- **DOCKER_MISSING** -> AskUserQuestion: "Docker is required for running agents. Want me to install it?"
  - macOS: `brew install --cask docker` then `open -a Docker`
  - Linux: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`
  - Note: Linux users may need to log out/in for docker group

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs -- common cause is runtime not fully started. Wait a moment and retry the test.
