{
  "version": 1,
  "organisation": {
    "name": "the team or company this work belongs to",
    "tickets": {
      "system": "where work comes from: Azure DevOps, Jira, GitHub Issues, email…",
      "whatATicketLooksLike": "what a ticket is called, what it always carries, who writes it",
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
      "who must be asked before a shared component changes",
      "who signs off"
    ],
    "doNotTouch": [
      "anything the bot must never change"
    ]
  },
  "projects": [
    {
      "name": "the short name this project goes by",
      "path": "C:\\Projects\\example",
      "what": "one sentence: what this project is",
      "structure": "the folders that matter and what lives in them",
      "howToReachItFromTheChat": "attached files, or the Desktop mirror at Desktop/copilot-operator-context/<project>/ where a file is named after its path with -- for each folder and .txt on the end, the project's name in front: example--src--main.ts.txt is src/main.ts in the project example",
      "runsWith": "the commands that build, start and test it",
      "versionControl": "whether the runner may branch and commit here"
    }
  ]
}
