# Using the MLsem extension

## In the editor

**Code lenses.** Above each top-level definition: its inferred type, or
`Untypeable: <reason>` where it fails.

**Hover.** On a variable, binder or call: its type. When the definition has
several `val` lines, one row per line, and with `mlsem.hover.overloadColors`
a colour per line that also tints the matching part of that `val` line.

**Highlight.** On a variable: where it is bound and used. On a type variable
in a `val` line: its occurrences in the definition's `val` lines, and the
parts of the body whose type mentions it.

**Quick actions** (Ctrl+.):

| Where | Action |
|---|---|
| A definition without `val` | *Inline inferred type*: writes the inferred type as `val` lines. |
| A hole in a draft `val` line | *Replace _ with T*, or *Replace all holes with their types*. |
| A `val` type | *Extract repeated parts* (as `where` definitions, or as holes), *Inline where definitions*. |
| A failing call | *Add overload: …* (a draft line for the argument's type), *Widen domain: …* (an existing line's domain grown to accept the argument). |

**Draft signatures.** A `val` line may contain holes, `_` or a named `'_a`
(all occurrences one type). The definition is checked against the shape and
the holes are inferred:

```
val len : [any*] -> _
let len l = match l with [] -> 0 | _::xs -> 1 + len xs end
```

`_` here is `int`.

## Type toolkit

`MLsem: Type toolkit…` opens a panel for the top-level definition at the
cursor. It follows the cursor. Each tool is a collapsible section; the title
bar has *Expand all* / *Collapse all*.

**Inferred type.** For a definition without `val` lines: its inferred type
as `val` lines. *Inline inferred type* checks them against the definition and
writes them above it, like the quick action of the same name.

**Draft holes.** The draft `val` lines with their holes filled. Click holes
of a row to select them, then *Fill*. A line whose definition needs several
overloads gets one row per overload: *Fill* on a row narrows the line to that
overload, *Split* replaces the line by all its rows. *Fill all* fills every
line; if some line has several rows the button reads *Fill all and split*
and splits those.

To fill a hole only in part, click under a part of its value in a row, as in
Widen: the part stays a hole `_` (click again to fill it back), and the line
as it will be written shows under the row. *Fill*, *Split* and *Fill all*
write the values with those parts as holes. For example, to say only that
`insert` returns a node, keep the node's contents of
`val insert : tree(string) -> int -> string -> Node(tree(string), int, string, tree(string))`
as a hole: *Fill* writes `... -> Node(_)`, and callers still get the whole
node. The line still checks: the whole value is one solution of the holes
left. A value is written in parentheses only where its hole needs them.

**Extract repeated parts.** Pick the parts of a `val` type that repeat and
name them; they become `where` definitions. For parts with holes: *Shared
holes* (all copies share them) or *Separate holes* (each hole a parameter, so
copies keep their own).

**Widen.** Click under a part of a `val` type to pick a wider type for it
(`42` → `int`, a hole `_` last). *Apply* writes every pick.

**Simplify.** Same, with equivalent simpler forms of a part, each with the
steps that give it.

**Overload merging.** Select `val` lines to combine:
- *Collapse*: the smallest single arrow containing them. Always holds, but
  loses which input gives which output.
- *Generalize*: one polymorphic type whose instances are the lines, checked
  against the definition and marked stronger, equivalent or weaker.
- *Domain subtraction*: makes the lines' domains disjoint, as first-match
  pattern matching would, over the first *n* arguments. Reports lines that
  become unreachable.

**Type variable instantiation.** Pin a type variable of a `val` line to a
concrete type, per line. Under each line, the instances its calls in this
file use.

**LLM inference.** Asks an LLM for the definition's `val` lines and checks
each answer; a rejected answer goes back with its type errors, up to
`mlsem.llm.maxTries`. Also `MLsem: Infer type with LLM` (editor title bar).
Providers are configured in `mlsem.llm.providers` / `mlsem.llm.anthropic`;
`MLsem: Set LLM API key` stores a key. These requests may be billed.

## Commands and settings

| Command | |
|---|---|
| `MLsem: Type toolkit…` | Open the panel. |
| `MLsem: Infer type with LLM` | See LLM inference. |
| `MLsem: Set LLM API key` | Store a provider's key. |
| `MLsem: Restart language server` | |

| Setting | |
|---|---|
| `mlsem.server.path` | The `lsp.exe` to run. |
| `mlsem.hover.overloadColors` | Colours in overload hovers. |
| `mlsem.llm.maxTries` | Answers to ask for before giving up. |
| `mlsem.llm.timeoutCountsAsFail` | Whether an answer whose check times out counts as a failed try (otherwise inference stops). |
| `mlsem.trace.server` | Log the LSP traffic. |
| `mlsem.debug.anchors` | In the toolkit, outline each part's text and draw lines from its anchor's ends, to check they line up. |
