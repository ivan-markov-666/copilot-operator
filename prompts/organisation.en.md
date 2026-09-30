{
  "version": 2,
  "organisation": {
    "tickets": {
      "system": "where work comes from: Azure DevOps, Jira, GitHub Issues, email…",
      "whatATicketLooksLike": "what a ticket always carries, and what a task needs out of it",
      "acceptanceCriteria": "where the acceptance criteria live and what they are called"
    },
    "sources": [
      "OneDrive: the folder to search and what is in it",
      "SharePoint or Teams: the site, the channel, the kind of document",
      "the wiki: the space, and which pages are authoritative"
    ],
    "conventions": {
      "branches": "how a branch is named, with an example",
      "commits": "the commit message style, with an example",
      "pullRequests": "how a pull request is opened, who reviews it, what must be green",
      "tests": "the command that runs the tests, and the coverage rule if there is one",
      "codeStandards": "language version, linter, formatter, anything enforced in review",
      "naming": "how files and folders are named",
      "templates": "the scaffolds and templates that must be used, and where they are",
      "definitionOfDone": "what makes a piece of work finished here"
    },
    "people": [
      "a change that needs somebody's say-so before it is made, and whose",
      "who signs the finished work off"
    ],
    "doNotTouch": [
      "anything the bot must never change"
    ]
  },
  "projects": [
    {
      "path": "C:\\Projects\\example",
      "what": "one sentence: what this project does",
      "structure": "the folders that matter and what lives in them",
      "prerequisites": "what must be installed, running or set before it builds: runtimes, services, environment variables",
      "runsWith": "the commands that build, start and test it",
      "knownPitfalls": "what goes wrong here that is not obvious from the code, and what to do about it",
      "versionControl": "whether the runner may branch and commit here"
    }
  ]
}
