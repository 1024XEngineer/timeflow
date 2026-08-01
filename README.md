# TimeFlow

## Web PR previews (Vercel)

Fork and same-repo pull requests can get an interactive web preview via Vercel.

### One-time setup (org admin)

1. Open [vercel.com](https://vercel.com) and sign in with GitHub.
2. **Add New Project** → import `1024XEngineer/timeflow`.
3. Set:
   - **Root Directory**: `frontend`
   - **Framework Preset**: Other
   - **Build Command**: `npx expo export --platform web` (or leave default from `frontend/vercel.json`)
   - **Output Directory**: `dist`
   - **Install Command**: `npm ci`
   - **Node.js Version**: `22.x`
4. Add **Preview** env vars (do not set these on Production unless you intend a fake demo deploy):
   - `EXPO_PUBLIC_USE_FAKE_WS=true` — explicit opt-in; required because `expo export` builds with `__DEV__=false`
   - `EXPO_PUBLIC_WS_URL=` (empty) — leave unset so the preview uses FakeWsServer
   - Optional: `EXPO_PUBLIC_BAIDU_MAP_AK` if map picker should work in the preview
5. Approve the Vercel GitHub App for the `1024XEngineer` org if prompted.
6. Fork PR deployments are gated by Vercel **Git Fork Protection** (Settings → Security):
   - Default: a Vercel team member must **authorize each fork PR deployment** (especially when the PR changes code or `vercel.json`). Expect a Deployments comment/request, not a fully automatic Preview URL on every external PR.
   - Optional (higher risk): disable Git Fork Protection only after auditing every Preview environment variable for secrets; then fork PRs can deploy without per-PR approval.

After setup, same-repo PRs get Preview URLs automatically. Fork PRs get a Preview URL after the authorization step above (or after Fork Protection is disabled). The existing GitHub Pages workflow only deploys same-repository branches.

### Local check

```bash
cd frontend
npm ci
EXPO_PUBLIC_USE_FAKE_WS=true EXPO_PUBLIC_WS_URL= npx expo export --platform web
```
