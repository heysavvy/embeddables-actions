# Embeddables Actions

GitHub Actions for Embeddables customers.

## `embeddables-deploy`

Deploys a Worker build to Embeddables hosting. Every push gets a commit URL and a branch URL on `embd.co`. A push to the app's production branch (usually `main`) also goes live on the production hostname and any custom domains.

Opening a pull request deploys its branch and comments the preview URL on it, even when the branch was pushed before the pull request existed. Later pushes to the branch update the preview. Pull requests from forks are skipped, because they cannot read the deploy key.

### Setup

1. In the Embeddables dashboard, open **Deployments**, register the app, and create a deploy key.
2. Add the key to the repository as the secret `EMBEDDABLES_DEPLOY_KEY`.
3. List the app in `embeddables/config.yaml`:

   ```yaml
   projectId: "<your project id>"
   hosting:
     apps:
       - slug: portal
         server: build/server
         client: build/client
   ```

   `server` and `client` are build output folders, relative to the repository root.

4. Add the workflow:

   ```yaml
   name: Deploy

   on:
     push:
     pull_request:
       types: [opened, reopened]

   permissions:
     contents: read
     pull-requests: write

   concurrency:
     group: deploy-${{ github.head_ref || github.ref_name }}
     cancel-in-progress: true

   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
           with:
             ref: ${{ github.event.pull_request.head.sha || github.sha }}
         # Replace with your project's install and build steps.
         - uses: actions/setup-node@v4
           with:
             node-version: 22
         - run: npm ci && npm run build
         - uses: heysavvy/embeddables-actions/embeddables-deploy@v1
           with:
             deploy-key: ${{ secrets.EMBEDDABLES_DEPLOY_KEY }}
   ```

### Inputs

| Input | Required | Default | |
|---|---|---|---|
| `deploy-key` | yes | | Project deploy key. Pass `secrets.EMBEDDABLES_DEPLOY_KEY`. |
| `app` | when config lists more than one app | | Hosting app slug to deploy. |
| `config` | no | `embeddables/config.yaml` | Config path from the repository root. |
| `api-origin` | no | `https://backend.embeddables.com` | Embeddables API origin. |

### Outputs

- `branch-url`: URL for the branch deploy.
- `commit-url`: URL for this commit's deploy.
