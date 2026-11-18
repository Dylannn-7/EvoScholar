# Fork notice

`src/` is copied from `packages/agent-harness/src` of https://github.com/aipoch/open-science
(Apache-2.0), excluding `*.test.ts`. Files are **unmodified**. EvoScholar extends the harness only
through its public options (`instructions`, `tools`, `guards`, `transformContext`, `admit`,
`onEvent`, `store`, delegation) from `@evoscholar/core`, so upstream fixes can be merged by
re-copying this directory. See `UPSTREAM-README.md` for the original documentation.
