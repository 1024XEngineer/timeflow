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
   - **Node.js Version**: `20.x`
4. Add Preview / Production env vars:
   - `EXPO_PUBLIC_USE_FAKE_WS=true`
   - `EXPO_PUBLIC_WS_URL=` (empty)
   - Optional: `EXPO_PUBLIC_BAIDU_MAP_AK` if map picker should work in the preview
5. In the Vercel project **Settings → Git**, enable deployments for pull requests from forked repositories.
6. Approve the Vercel GitHub App for the `1024XEngineer` org if prompted.

After that, each PR receives a Preview URL comment from Vercel. The existing GitHub Pages workflow only deploys same-repository branches; fork PRs should use Vercel.

### Local check

```bash
cd frontend
npm ci
npx expo export --platform web
```
