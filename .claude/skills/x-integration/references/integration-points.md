### Integration Points

To integrate this skill into NanoClaw, make the following modifications:

---

**1. Host side: `src/ipc.ts`**

Add import after other local imports:
```typescript
import { handleXIpc } from '../.claude/skills/x-integration/host.js';
```

Modify `processTaskIpc` function's switch statement default case:
```typescript
// Find:
default:
logger.warn({ type: data.type }, 'Unknown IPC task type');

// Replace with:
default:
const handled = await handleXIpc(data, sourceGroup, isMain, DATA_DIR);
if (!handled) {
    logger.warn({ type: data.type }, 'Unknown IPC task type');
}
```

---

**2. Container side: `container/agent-runner/src/ipc-mcp.ts`**

Add import after `cron-parser` import:
```typescript
// @ts-ignore - Copied during Docker build from .claude/skills/x-integration/
import { createXTools } from './skills/x-integration/agent.js';
```

Add to the end of tools array (before the closing `]`):
```typescript
    ...createXTools({ groupFolder, isMain })
```

---

**3. Build script: `container/build.sh`**

Change build context from `container/` to project root (required to access `.claude/skills/`):
```bash
# Find:
docker build -t "${IMAGE_NAME}:${TAG}" .

# Replace with:
cd "$SCRIPT_DIR/.."
docker build -t "${IMAGE_NAME}:${TAG}" -f container/Dockerfile .
```

---

**4. Dockerfile: `container/Dockerfile`**

First, update the build context paths (required to access `.claude/skills/` from project root):
```dockerfile
# Find:
COPY agent-runner/package*.json ./
...
COPY agent-runner/ ./

# Replace with:
COPY container/agent-runner/package*.json ./
...
COPY container/agent-runner/ ./
```

Then add COPY line after `COPY container/agent-runner/ ./` and before `RUN npm run build`:
```dockerfile
# Copy skill MCP tools
COPY .claude/skills/x-integration/agent.ts ./src/skills/x-integration/
```
