# Custom specialist roles

These three roles supplement Agency Agents without changing its imported files. Their descriptions expose the selection boundaries in the picker and read-only `roles` tool; their bodies explain the same boundaries to the model. They are role data, not new extensions or skills, and grant no tools or permissions.

| ID | Use it for | Prefer another role for |
| --- | --- | --- |
| `root-cause-debugger` | An unexplained, disputed, intermittent, or unsuccessfully fixed software failure | `minimal-change-engineer` for an already-diagnosed patch; `incident-response-commander` for production response; `sre` for ongoing reliability |
| `local-environment-setup` | Getting an existing checkout running on a local workstation | `devops-automator` for CI/CD and deployments; `platform-engineer` for shared platforms; `codebase-onboarding-engineer` for read-only orientation |
| `technical-kb-curator` | Searching and maintaining evidenced technical troubleshooting records | `technical-writer` for general developer docs; `zk-steward` for personal linked notes; `support-responder` for customer service; `root-cause-debugger` for new diagnosis |

## Selection examples

| Request | Role | Reason |
| --- | --- | --- |
| Login sometimes returns 500; previous guesses did not fix it | `root-cause-debugger` | Cause is not established |
| Fix this proven off-by-one error and keep the patch focused | `minimal-change-engineer` | Diagnosis is already available |
| A new checkout needs the declared Node version and local database | `local-environment-setup` | Workstation prerequisites |
| The checkout uses valid prerequisites, but a test still fails due to application logic | `root-cause-debugger` | Software defect rather than setup |
| Installation fails because the declared package manager is unavailable | `local-environment-setup` | Missing local prerequisite |
| Installation fails with matching prerequisites due to a defect in the install script | `root-cause-debugger` | The command name alone does not determine the role |
| Build a release pipeline and deploy to cloud | `devops-automator` | Delivery infrastructure |
| Explain the startup call path without editing anything | `codebase-onboarding-engineer` | Read-only orientation |
| Record a proven installation fix with versions and exact error text | `technical-kb-curator` | Reusable operational knowledge |
| Write the project's installation tutorial or API reference | `technical-writer` | Developer documentation |
| Organize study notes as an interconnected knowledge network | `zk-steward` | Personal note methodology |
| Search whether a known fix applies to this project's version | `technical-kb-curator` | Applicability of existing records |
| Coordinate an outage and mitigation while customers are affected | `incident-response-commander` | Incident command rather than a bounded diagnosis |

An unknown cause is the debugger's defining trigger; a missing local prerequisite is the setup engineer's; reusable troubleshooting evidence is the curator's. Overlapping command names or file types are insufficient to select a role. Boundary tables are guidance, not automatic role switching or delegation.

## Install explicitly

Files are bundled under `roles/custom/`. The runtime discovers user and trusted project catalogs, not this package directory. Copy only these three files into the desired catalog; existing installations do not change automatically.

For a user catalog, from the package/source root in PowerShell:

```powershell
$catalogPath = Join-Path $env:USERPROFILE '.pi\agent\roles\custom'
$approvedRoleIds = @('root-cause-debugger', 'local-environment-setup', 'technical-kb-curator')
$catalogRoot = Split-Path $catalogPath -Parent
$existingIds = if (Test-Path -LiteralPath $catalogRoot) {
    Get-ChildItem -LiteralPath $catalogRoot -Recurse -File -Filter '*.md' |
        Where-Object { $_.BaseName -in $approvedRoleIds }
}
if ($existingIds) { throw 'Review existing role IDs before installing; do not create duplicates or overwrite custom edits.' }
New-Item -ItemType Directory -Path $catalogPath -Force | Out-Null
foreach ($approvedRoleId in $approvedRoleIds) {
    Copy-Item -LiteralPath "roles\custom\$approvedRoleId.md" -Destination $catalogPath
}
```

Use the actual agent directory if it differs from the default. For a trusted project, use `.pi/roles/custom` in that project instead. Do not place READMEs or migration notes inside a role catalog: plain Markdown files are also treated as roles.

Inspect with `/roles root-cause` or `/role show`. In Pi default, select with `/role root-cause-debugger`, `/role local-environment-setup`, or `/role technical-kb-curator`. A named agent uses its configured role; return with `/agent reset` before selecting an independent base-conversation role. No defaults are assigned to existing agents.

## Scope and origin

These are revised role versions of the locally reviewed `debugger.md`, `environment-setup.md`, and `faq-agent.md`. The revisions narrow responsibilities, remove ambiguous routing, and make the alternatives explicit. They do not claim a verified external repository origin for those local inputs.

The review's workflow candidates, Development Requirements Analyst, README, and Theia integration notes are outside this addition. They are not imported, converted to skills, deleted, or edited by this change. Agency Agents instructions and metadata remain unchanged.
