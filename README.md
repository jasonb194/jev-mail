# Gmail categorization with Jev

This Google Apps Script checks Gmail on a time trigger and sends eligible threads to a configurable classification API. By default it uses TypeSafe Jev. The project has no web UI; configure it in Apps Script Script Properties.

## Behavior

- The trigger runs every 5 minutes by default. `JEV_ENABLED` defaults to `false`, so setup does not process mail until you turn it on.
- Each run fetches up to 100 candidate threads and classifies at most 30. Remaining threads are considered on later runs.
- `JEV_SCOPE=INBOX` selects threads with inbox mail. `JEV_SCOPE=ALL` also searches archived mail. Both modes exclude sent messages, drafts, Spam, and Trash; those messages are omitted even when they are part of an otherwise eligible thread.
- The configured API provider receives every eligible incoming message in each selected thread, with its sender, subject, and plain-text body. HTML-only bodies are converted to text. Attachments are not sent.
- The script asks Jev about all nine categories. It applies the category's **display label** when that category's Noul probability is greater than `0.75`. Every successfully classified thread gets the `JEV` label; if no category exceeds the threshold, it gets only `JEV`.
- The script never archives mail. It adds labels only to eligible incoming messages and does not remove existing labels. Sent messages are never sent to the provider or labeled. Email content is sent for classification and is not stored by this script.

Categories:

- Jev-Pending
- Jev-People & Personal
- Jev-Work & Career
- Jev-Home & Services
- Jev-Health & Benefits
- Jev-Money & Official Records
- Jev-Transactions & Bookings
- Jev-Accounts & Security
- Jev-News & Promotions

## Deploy from a cloned repository with clasp

This is a standalone Apps Script project. [`clasp`](https://developers.google.com/apps-script/guides/clasp) uploads its source to GAS; a one-time editor run grants the script's Gmail permissions and installs its timer. A web app deployment is not needed.

### Prerequisites

1. Install [Node.js 20 or later](https://nodejs.org/).
2. Enable the [Apps Script API](https://script.google.com/home/usersettings) for the Google account that will own the script.
3. Install clasp and sign in with that account:

   ```sh
   npm install -g @google/clasp
   clasp login
   ```

4. Clone this repository and open a terminal in the repository root.

### Create a script project and push the code

Create a new standalone GAS project with clasp, but run `clasp create` in a separate, empty temporary directory. It downloads starter files into its current directory, which could overwrite this repository's tracked source files if run here.

From the cloned repository root, these PowerShell commands create the remote project in a unique temporary folder, copy only its local project binding into the clone, then push this repository's source:

```powershell
$repoRoot = (Get-Location).Path
$bootstrapDir = Join-Path $env:TEMP ("jev-mail-clasp-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $bootstrapDir | Out-Null
Push-Location $bootstrapDir
clasp create --title "Jev Mail" --type standalone
Pop-Location
Copy-Item (Join-Path $bootstrapDir ".clasp.json") (Join-Path $repoRoot ".clasp.json")
clasp show-file-status
clasp push
```

On macOS or Linux, run `clasp create --title "Jev Mail" --type standalone` in a separate empty temporary directory, copy only the generated `.clasp.json` into the repository root, then run `clasp show-file-status` and `clasp push` there. Do not copy the temporary directory's `Code.gs` or `appsscript.json`; this repository's files are the source of truth. `.clasp.json` is per-user and is ignored by Git.

`clasp push` uploads the project source and manifest. The manifest already declares Gmail API v1 and the needed OAuth scopes. If you link the script to a standard Google Cloud project, enable the Gmail API in that Cloud project too.

### Authorize and start the trigger

1. From the repository root, open the GAS project:

   ```sh
   clasp open-script
   ```

2. In the Apps Script editor, select `initializeJevProperties` and click **Run**. Choose your Google account and approve the requested permissions. This creates the five-minute trigger and seeds missing property defaults; processing stays off because `JEV_ENABLED` defaults to `false`.
3. Open **Project Settings → Script Properties**. Set `JEV_API_KEY` to your provider's API key, then review `JEV_API_URL`, `JEV_MODEL`, `JEV_SCOPE`, and `JEV_INTERVAL_MINUTES`. Set `JEV_ENABLED` to `true` when ready to begin processing.

The manifest requests Gmail access (`gmail.modify`), permission to manage Apps Script triggers (`script.scriptapp`), and permission to call the configured API (`script.external_request`). Google's [`gmail.modify` scope](https://developers.google.com/workspace/gmail/api/auth/scopes) includes composing and sending mail, but this code only reads messages and applies labels; it does not send or archive mail. The installable trigger runs as the account that created it. For later code updates, run `clasp push` from the repository root. `clasp deploy` is for versioned web apps, add-ons, or API executables and is not required for this time-driven script.

## Script Properties

| Property | Default | Values / purpose |
| --- | --- | --- |
| `JEV_API_KEY` | empty | Required API key. Set this before enabling processing. |
| `JEV_ENABLED` | `false` | `true` enables scheduled processing; `false` pauses it. |
| `JEV_SCOPE` | `INBOX` | `INBOX` or `ALL`. |
| `JEV_INTERVAL_MINUTES` | `5` | `1`, `5`, `10`, `15`, or `30`. A changed interval is applied when the trigger next runs. |
| `JEV_MODEL` | `jev-latest` | Model identifier understood by the configured provider. |
| `JEV_API_URL` | `https://api.typesafe.ai/v1/systemone` | Complete HTTPS API endpoint, including host and path. |

To use another provider, set `JEV_API_URL` to its full endpoint and update `JEV_MODEL` and `JEV_API_KEY`. The provider must accept the same JSON request and Bearer API-key authentication; provider-specific request or authentication formats are not configurable in this script.

The trigger remains installed while `JEV_ENABLED` is false, but makes no Gmail search or Jev request. To stop scheduled processing, set it back to `false`.

## Failures and retries

Configuration, Gmail search, Jev request, and invalid-response failures are logged without logging email content or the API key. The script applies labels to eligible messages in one Gmail batch request after classification succeeds. Failed threads remain unmarked and eligible for a later run. Threads with more than 1,000 eligible messages are skipped before labeling because Gmail's batch-label request limit is 1,000 message IDs; they remain candidates and will be skipped on later runs.

Provider HTTP 429 and 529 responses are retried with exponential delays of 1 and 2 seconds. If the provider continues to rate-limit the request, the script stops the current batch; unattempted threads are deferred to a later trigger.
