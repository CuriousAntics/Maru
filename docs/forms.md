# Forms

Build forms on Maru's staff website, publish a Discord post with a **Fill out form** button, collect private answers inside Discord, and review submissions on the website. This covers applications, reports, event signups and suggestions through configurable questions.

## Build and publish

1. Sign in to the dashboard and choose **Forms → Create form**.
2. Enter a title and description, then add questions. Choose **Short answer**, **Paragraph**, **Multiple choice**, **Checkboxes**, or **File upload**. Set required/optional per question.
3. For choice questions, enter one option per line. Use Move up/Move down to change question order. Add, move and remove preserve your current fields but do not save them; finish with **Save form** or **Publish form post**. Save form is available at the top and bottom of the builder.
4. Turn **Accept responses** On, select a channel and choose **Publish form post**. This submits the same builder fields as Save form, saves every current question and queues that exact revision in one database transaction. A separate save is optional. The success notice reports the saved question count. The publication result appears on this page after the delivery worker runs (normally within five seconds). Reload to see its result and Discord link.
5. Members click **Fill out form**, see the description and identity notice privately, then click **Begin form**. Longer forms use Continue between sections. Answers enter the staff queue only when the final section is submitted.
6. Staff filter submissions by form/status, open a response, download any files and choose **Approve and notify** or **Reject and notify**. The optional message is sent to the submitter with the decision. The saved response shows the DM outcome.

New forms default closed. Old Discord posts open the latest saved version of their form. Turning a form Off blocks all new starts and unfinished drafts; the old post stays in Discord. Editing a saved form invalidates unfinished drafts so changed questions cannot be mixed. Finished submissions retain the original title, questions and answers. Publishing again creates a new post; it does not edit prior posts.

## Access and behavior

- Admins and Mods granted full access can build, edit and publish forms. All currently configured staff can read submissions, download submitted files and review them. Staff roles and sessions are checked on the website; mutations check them again before committing.
- Anyone who can see the published Discord post can apply. Forms are not anonymous: the submitter's Discord user ID is saved and shown to staff. Forms have no role restrictions or automatic role grants in this version.
- Each member has one unfinished draft per form, resumable through the original post for 24 hours. Expired drafts and their files are deleted by the worker. Drafts are excluded from staff response views and file downloads. Multiple completed submissions are allowed, with a one-minute cooldown per member across forms.
- Up to 50 active forms can be configured. A form contains 1–25 questions, split into sections of at most five. Choice questions support 2–10 options. Short answers accept 300 characters; paragraphs accept 4,000. Every question can be optional.
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

## Delete forms and retain your place

An Admin or full-access Mod can open a saved form and choose **Delete form…** below the publishing controls. The confirmation page offers two choices:

- **Keep submitted responses and their files** (default): removes the form from Your forms and closes all its Discord buttons. Saved responses, files and pending reviews remain accessible under Submissions; the form filter labels it `(deleted)`.
- **Permanently delete submitted responses and their files**: removes those entries and stored uploads as well. This cannot be undone through Maru.

Both choices discard unfinished drafts and their files, cancel queued publications and free a slot in the active-form limit. Existing Discord posts remain visible but cannot start new answers. Deletion records a closed form marker so old links cannot recreate it. Type `DELETE` to confirm. If a publication is already sending, wait for it to finish before deleting. A decision notification already in progress may finish even when its submission is deleted.

The shared staff dashboard now retains scroll position after same-page saves, filters and question removal. Adding a question or moving one brings that question into view. Validation failures bring the error into view. This uses a small static script authorized by the page's CSP nonce and one-shot browser session storage; browser storage never contains answers, tokens or file data. Normal navigation to another page is unaffected. Add/move buttons also provide fragment anchors when scripting is unavailable.

### Follow-up patch installation

Apply `maru-form-controls.patch` after the original Forms patch is merged. This includes the save/publish fix, deletion, scroll retention, answer tables and named submitters. Use this updated copy instead of either earlier unapplied patch:

```powershell
git switch main
git pull --ff-only
git switch -c fix/form-controls
git apply --check .\Patches\maru-form-controls.patch
git apply .\Patches\maru-form-controls.patch
npm run check
npm run build
node --import tsx --test --test-concurrency=2 test/*.test.ts
npm run db:migrate
```

Migration `022_form_deletion.sql` adds the deletion marker and prevents deleted forms from being enabled. Migration `023_form_response_identity.sql` adds respondent-name fields for new and older responses. Apply both to the bot database before running the updated code; use the existing Railway pre-deploy migration command for hosted deployment.

After deployment, use a disposable form to check both deletion choices, retained-file downloads, and an old Discord button. Check adding/moving questions and saving while scrolled down in your browser. Automated tests cover database/HTTP deletion and scroll event handling; the browser visual check still needs to be performed on the running site.

### Publishing unsaved questions

The original builder and Publish button used separate HTML forms. Publishing submitted only the saved form ID and reloaded the editor, which could discard newly added questions. Publish now belongs to the builder's form and submits all question fields, the channel and a request ID together. Saving and queuing publication either both commit or both roll back. Missing channels, invalid questions, closed forms and stale editors cannot publish an older version in place of the current edits. A failed validation keeps current editor fields visible. Duplicate submissions of the same request cannot create another saved revision or post; reusing a request with different edits is rejected visibly.

The first submit button in the builder is now Save form, so pressing Enter in a single-line field cannot accidentally move/remove a question. Multi-line fields retain their normal Enter behavior. The destination channel is required for publishing, not for saving or rearranging questions.

Regression check: add several questions without clicking Save form, choose the channel and click Publish form post. Confirm the success notice reports the full question count, reopen the editor, then open the Discord form and check all questions. Also try publishing with a choice question that has too few options: the error must preserve every question, and no new publication may be queued.

## Answer tables and respondent names

Click **Answers table** beside a form, or select a form and choose **Answers table** in the Submissions view filter. Each row is one submitted response; columns show the respondent, submission time, review link, status, DM result, and each question's answer. Filter by pending/approved/rejected/all. There are 50 responses per page, with form/status/view preserved when paging. Horizontal scrolling exposes wide forms and the header stays visible while scrolling rows. Paragraphs longer than 160 characters can be expanded inside their cell; files remain authenticated download links. Drafts are never included.

Question headings are drawn from the current form and saved response snapshots. Renamed or removed questions keep separate headings, and reordering does not shift old answers into the wrong column. Repeated identical question labels/types are numbered in their original order. For unambiguous reporting, use distinct question labels. All historical headings remain consistent across page/status filters.

New submissions capture the member's server display name (falling back to global display name or username), their `@username`, and their Discord user ID when the final section is submitted. The list, table and response detail show these names. The saved ID remains the stable identity when names change; later profile lookups never replace a submission-time name.

Older responses contain only IDs. When staff view them, Maru resolves up to ten unique missing respondent names per page request and stores successful lookups with a **Name retrieved after submission** label. These names were obtained later, not at the original submission. Multiple responses by one member share that lookup. If the member has left the server, Maru attempts an account lookup. Unknown/deleted accounts or temporary Discord failures show **Name unavailable** with the ID, and failures back off for 15 minutes. Answers remain accessible even when a name cannot be resolved. Refreshing or browsing more responses fills additional legacy names without changing their answers.

Live checks: submit a form and verify the name, handle and ID on both the list and detail page; open Answers table and confirm all question values/files; review an older response to confirm a lookup name appears where Discord can resolve the account. No new environment variables, packages or gateway intents are required.

## Save scroll repair

`maru-form-scroll-repair.patch` fixes scroll-position capture for forms with controls named `action` or `target`, including the form builder's Save and Publish buttons. Named controls mask native properties on HTMLFormElement; the script now reads the form's markup attributes instead. Regression tests model a single named control, multiple controls, and a named target, while retaining the existing destination and question-anchor behavior.

Apply after the Forms controls update (PR #32). No database migration, dependency update or command registration is required. After deployment, scroll to the bottom of a multi-question form, click the lower Save form button and confirm it returns to that position. Also confirm Add question still brings the new card into view.
