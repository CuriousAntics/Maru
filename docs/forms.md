# Forms

Build forms on Maru's staff website, publish a Discord post with a **Fill out form** button, collect private answers inside Discord, and review submissions on the website. This covers applications, reports, event signups and suggestions through configurable questions.

## Build and publish

1. Sign in to the dashboard and choose **Forms → Create form**.
2. Enter a title and description, then add questions. Choose **Short answer**, **Paragraph**, **Multiple choice**, **Checkboxes**, or **File upload**. Set required/optional per question.
3. For choice questions, enter one option per line. Use Move up/Move down to change question order. Add, move and remove preserve your current fields but do not save them; finish with **Save form**.
4. Turn **Accept responses** On and save. Select a channel and choose **Publish form post**. The publication result appears on this page after the delivery worker runs (normally within five seconds). Reload to see its result and Discord link.
5. Members click **Fill out form**, see the description and identity notice privately, then click **Begin form**. Longer forms use Continue between sections. Answers enter the staff queue only when the final section is submitted.
6. Staff filter submissions by form/status, open a response, download any files and choose **Approve and notify** or **Reject and notify**. The optional message is sent to the submitter with the decision. The saved response shows the DM outcome.

New forms default closed. Old Discord posts open the latest saved version of their form. Turning a form Off blocks all new starts and unfinished drafts; the old post stays in Discord. Editing a saved form invalidates unfinished drafts so changed questions cannot be mixed. Finished submissions retain the original title, questions and answers. Publishing again creates a new post; it does not edit prior posts.

## Access and behavior

- Admins and Mods granted full access can build, edit and publish forms. All currently configured staff can read submissions, download submitted files and review them. Staff roles and sessions are checked on the website; mutations check them again before committing.
- Anyone who can see the published Discord post can apply. Forms are not anonymous: the submitter's Discord user ID is saved and shown to staff. Forms have no role restrictions or automatic role grants in this version.
- Each member has one unfinished draft per form, resumable through the original post for 24 hours. Expired drafts and their files are deleted by the worker. Drafts are excluded from staff response views and file downloads. Multiple completed submissions are allowed, with a one-minute cooldown per member across forms.
- Up to 50 forms can be configured. A form contains 1–25 questions, split into sections of at most five. Choice questions support 2–10 options. Short answers accept 300 characters; paragraphs accept 4,000. Every question can be optional.
- File questions accept one file each, at most 10 MiB per file and 20 MiB total per response. Discord's own upload limits also apply. Files are copied immediately into PostgreSQL and served as downloads only after current staff authentication; temporary Discord URLs are not used for later review. No file preview or execution is provided. Submitted responses and files remain saved; account for their size in database storage and backups. If a file cannot be downloaded or exceeds the limits, its section stays unsaved and the member can reopen it with Continue.
- Completed responses are reviewed on the website, not copied to a Discord review channel. Answers and file data are excluded from the general audit log and decision DMs. Audit events contain form/entry IDs, actor IDs, revision or decision only.
- Approve/reject is a final status in this version. Simultaneous reviews use the response revision; only one decision can commit. Event signups can use approval to confirm a slot; reports and suggestions can use approval/rejection to record the staff decision.
- Decision DM outcomes are pending/sending/sent/failed/unknown. A sent DM means Discord confirmed message creation, not that it was read. Failed means Discord rejected delivery. Unknown means delivery may have succeeded; it is never automatically repeated. The decision stays saved even when the DM fails. No existing response is reposted on retries or restarts.
- Publishing checks the saved revision, current full-access staff permissions and the destination channel. Maru needs View Channel, Send Messages and Embed Links in a text or announcement channel. A queued post is cancelled if its form changes or closes before delivery. Unknown publications need a manual channel check before publishing another post.

## Apply the patch on Windows

From `G:\GitHub\Maru`, with the previous inline-command patch merged and a clean working tree:

```powershell
git switch main
git pull --ff-only
git switch -c feature/forms
git apply --check .\Patches\maru-forms.patch
git apply .\Patches\maru-forms.patch
npm run check
npm run build
node --import tsx --test --test-concurrency=2 test/*.test.ts
```

Apply migration `021_forms.sql` to the database used by the bot **before starting the new bot code**:

```powershell
npm run db:migrate
```

Then restart the bot through your existing deployment workflow. For Railway, use the configured migration/pre-deploy workflow against its database; the repository's Docker startup command itself does not run migrations. Do not start two bot processes against the same test server for the live check.

No new environment variables, packages, gateway intents or slash-command registration are required. The published post's button starts the flow; no `/forms` command is added.

## Live acceptance check

1. Create a closed test form with one question of each type. Save, switch On, save, and publish to a private test channel. Confirm one post and a working button.
2. Submit all five types, including a small file. Check choice values, checkbox selections, user ID and downloaded file contents on the website.
3. Add a sixth question, save, and start a new draft. Confirm Continue reaches section two and nothing appears in the staff queue before completion.
4. Approve one response with a message; reject another. Check decision status and DM outcome. Test a member with closed DMs to confirm the review remains saved.
5. Close a form and check that an old post no longer accepts answers. Confirm existing submitted answers remain available after a question edit.
6. Check a normal member cannot access the website, an ordinary Mod can review, and only an Admin or full-access Mod can publish.

Automated checks cover PostgreSQL migrations and transactions using PGlite, HTTP authorization and CSRF, real discord.js modal serialization and field parsing, bounded Discord attachment downloads, section deduplication, snapshots, review conflicts, and restart-safe delivery claims. Live Discord/Railway checks require your running test setup.

## Discord references

- [Modal response structure and limits](https://docs.discord.com/developers/interactions/receiving-and-responding#interaction-response-object-modal)
- [Modal components, radio groups, checkbox groups and file uploads](https://docs.discord.com/developers/components/reference)
