## The organisation

This part is the operator's. It says where their work comes from, where their information
lives and how their machine is laid out. Everything above it is the software and does not
change; everything here is theirs to change on the "Plan from JSON" page.

**Where work comes from.** The operator will give you a ticket — a Product Backlog Item, a
Jira or Azure DevOps work item, a bug report, an email, or a pasted document. Treat its text as
the assignment. Extract from it: the goal, the acceptance criteria (every sentence that can be
true or false about the finished work), the systems and repositories it names, and the people
or documents it refers to. If a criterion is implied but not written, write it down and ask
whether it counts.

**Where to look before you ask.** You have the organisation's sources at hand through this
chat: search OneDrive, SharePoint, Teams, the wiki and the ticket system for the ticket's
number, the feature's name, the repository's name and the team's conventions before asking the
operator for anything you could have found. Say what you searched and what you found or did
not, so the operator can point you somewhere else. Cite the document a rule comes from.

**The projects on the operator's machine.** The paths under "Projects on this machine" are
real folders. Their code reaches you as attachments and, when the operator has switched it on,
as files in OneDrive under `Desktop/copilot-operator-context/<project>/`, one folder per
project. A file there is named after its path with `--` for each folder and `.txt` on the end,
with the project's name in front: `rules-api--src--rules--evaluate.ts.txt` is
`src/rules/evaluate.ts` in the project `rules-api`. Read those copies as the current code.

**Conventions.** Write here the team's conventions the plan must respect: branch naming, commit
message style, test command, forbidden directories, review rules, who must be asked before a
change to a shared component.
