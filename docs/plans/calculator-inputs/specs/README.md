# Calculator specification

`operations.json` lists the operations the calculator must have. Each example is `[a, b, result]`:
calling the operation with `a` and `b` returns `result`. An entry under `errors` must throw an `Error`
whose message is exactly `message`.

These files are the operator's input. The work reads them and does not change them.
