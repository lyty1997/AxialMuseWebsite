const PACKAGE_MANAGER_COMMANDS = new Set([
  "npm",
  "npm-cli.js",
  "npx",
  "npx-cli.js",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "corepack",
]);

function splitShellSegments(text) {
  const segments = [];
  let buffer = "";
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      buffer += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      buffer += character;
      escaped = true;
      continue;
    }
    if (quote) {
      buffer += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      buffer += character;
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/.test(text[index - 1]))) {
      while (index < text.length && text[index] !== "\n") index += 1;
      if (buffer.trim() !== "") segments.push(buffer);
      buffer = "";
      continue;
    }
    if (character === "\n" || character === ";" || character === "|" || character === "&") {
      if (buffer.trim() !== "") segments.push(buffer);
      buffer = "";
      continue;
    }
    buffer += character;
  }
  if (buffer.trim() !== "") segments.push(buffer);
  return segments;
}

function tokenizeShellSegment(segment) {
  const tokens = [];
  let token = "";
  let tokenStarted = false;
  let quote = null;
  let escaped = false;
  for (const character of segment) {
    if (escaped) {
      token += character;
      tokenStarted = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      tokenStarted = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (tokenStarted) tokens.push(token);
      token = "";
      tokenStarted = false;
      continue;
    }
    token += character;
    tokenStarted = true;
  }
  if (escaped) token += "\\";
  if (tokenStarted) tokens.push(token);
  return tokens;
}

function resolveVariable(token, variables) {
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/.exec(token);
  if (!match) return token;
  return variables.get(match[1] ?? match[2]) ?? null;
}

function commandBasename(token) {
  return token.toLowerCase().split(/[\\/]/).at(-1);
}

function expandSimpleBraces(pattern) {
  const start = pattern.indexOf("{");
  const end = pattern.indexOf("}", start + 1);
  if (start === -1 || end === -1) return [pattern];
  const alternatives = pattern.slice(start + 1, end).split(",");
  if (alternatives.length < 2 || alternatives.some((item) => item === "")) return [pattern];
  return alternatives.flatMap((alternative) =>
    expandSimpleBraces(`${pattern.slice(0, start)}${alternative}${pattern.slice(end + 1)}`),
  ).slice(0, 32);
}

function shellGlobMatches(pattern, value) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else if (character === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) {
        source += "\\[";
        continue;
      }
      let content = pattern.slice(index + 1, end);
      if (content.startsWith("!")) content = `^${content.slice(1)}`;
      source += `[${content.replaceAll("\\", "\\\\")}]`;
      index = end;
    } else {
      source += character.replace(/[.+^$()|\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(`${source}$`, "u").test(value);
  } catch {
    return false;
  }
}

function tokenMayNamePackageManager(token) {
  const basename = commandBasename(token);
  if (PACKAGE_MANAGER_COMMANDS.has(basename)) return true;
  if (!/[?*[\]{}]/.test(basename)) return false;
  return expandSimpleBraces(basename).some((pattern) =>
    [...PACKAGE_MANAGER_COMMANDS].some((name) => shellGlobMatches(pattern, name)),
  );
}

function consumeAssignments(tokens, start, variables) {
  let index = start;
  while (index < tokens.length) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(tokens[index]);
    if (!match) break;
    const value = resolveVariable(match[2], variables);
    variables.set(match[1], value ?? match[2]);
    index += 1;
  }
  return index;
}

function containsCommandSubstitution(text) {
  for (let start = text.indexOf("$("); start !== -1; start = text.indexOf("$(", start + 2)) {
    let depth = 1;
    for (let index = start + 2; index < text.length; index += 1) {
      if (text.startsWith("$(", index)) {
        depth += 1;
        index += 1;
      } else if (text[index] === ")") {
        depth -= 1;
        if (depth === 0 && hasDirectPackageManagerCommand(text.slice(start + 2, index))) return true;
        if (depth === 0) break;
      }
    }
  }
  return false;
}

function segmentInvokesPackageManager(segment, variables) {
  const tokens = tokenizeShellSegment(segment);
  let index = consumeAssignments(tokens, 0, variables);
  if (index >= tokens.length) return false;

  let command = resolveVariable(tokens[index], variables);
  if (command === null) return true;
  if (command.includes("$") || command.startsWith("`")) return true;
  let name = commandBasename(command);

  while (name === "command" || name === "env" || name === "exec" || name === "builtin") {
    const wrapper = name;
    index += 1;
    while (tokens[index]?.startsWith("-")) {
      const option = tokens[index];
      index += 1;
      if (
        (wrapper === "env" && ["-u", "--unset", "-C", "--chdir"].includes(option))
        || (wrapper === "exec" && option === "-a")
      ) {
        index += 1;
      }
      if (wrapper === "env" && ["-S", "--split-string"].includes(option)) return true;
    }
    index = consumeAssignments(tokens, index, variables);
    if (index >= tokens.length) return false;
    command = resolveVariable(tokens[index], variables);
    if (command === null) return true;
    if (command.includes("$") || command.startsWith("`")) return true;
    name = commandBasename(command);
  }

  if (name === "alias" || name === "unalias") return true;
  if (tokenMayNamePackageManager(command)) return true;
  if (
    name !== "echo"
    && name !== "printf"
    && tokens.some((token) => tokenMayNamePackageManager(resolveVariable(token, variables) ?? token))
  ) {
    return true;
  }
  if (name === "node" && tokenMayNamePackageManager(tokens[index + 1] ?? "")) {
    return true;
  }
  if (name === "eval") return hasDirectPackageManagerCommand(tokens.slice(index + 1).join(" "));
  if (["bash", "dash", "sh", "zsh"].includes(name)) {
    const commandIndex = tokens.findIndex((token, tokenIndex) => tokenIndex > index && /^-[^-]*c/.test(token));
    if (commandIndex !== -1 && tokens[commandIndex + 1]) {
      return hasDirectPackageManagerCommand(tokens.slice(commandIndex + 1).join(" "));
    }
  }
  return false;
}

export function hasDirectPackageManagerCommand(text) {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return false;
  if (containsCommandSubstitution(text)) return true;
  const variables = new Map();
  return splitShellSegments(text).some((segment) => segmentInvokesPackageManager(segment, variables));
}

export function findShellPackageManagerCommands(text) {
  const findings = [];
  const variables = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (
      trimmed !== ""
      && !trimmed.startsWith("#")
      && (
        containsCommandSubstitution(line)
        || splitShellSegments(line).some((segment) => segmentInvokesPackageManager(segment, variables))
      )
    ) {
      findings.push({ line: index + 1, command: trimmed });
    }
  }
  return findings;
}

function decodeWorkflowScalar(scalar) {
  const trimmed = scalar.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      return typeof decoded === "string" ? decoded : null;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) return null;
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (/^(?:!|&|\*|\$\{\{)/.test(trimmed)) return null;
  return trimmed;
}

function workflowScalarHasBypass(scalar) {
  const decoded = decodeWorkflowScalar(scalar);
  return decoded === null || hasDirectPackageManagerCommand(decoded);
}

export function findWorkflowPackageManagerCommands(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("#")) continue;
    if (/^\s*(?:-\s+)?"[^"]*\\[^"]*"\s*:/.test(line)) {
      findings.push({ line: index + 1, command: "unsupported YAML escaped mapping key" });
      continue;
    }
    const run = /^(\s*)(?:(-\s+))?(?:"run"|'run'|run)\s*:\s*(.*)$/.exec(line);
    if (!run) {
      if (
        /^\s*(?:-\s*)?(?:[A-Za-z_][A-Za-z0-9_-]*\s*:\s*)?[\[{]/.test(line)
        || /^\s*\?\s*(?:"run"|'run'|run)\s*$/.test(line)
      ) {
        findings.push({ line: index + 1, command: "unsupported YAML flow syntax" });
      }
      continue;
    }

    const scalar = run[3];
    const mappingIndent = run[1].length + (run[2]?.length ?? 0);
    const blockHeader = /^([|>])(?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?$/.exec(scalar);
    if (blockHeader) {
      const blockLines = [];
      let next = index + 1;
      while (next < lines.length) {
        const candidate = lines[next];
        const indentation = candidate.match(/^\s*/)[0].length;
        if (candidate.trim() !== "" && indentation <= mappingIndent) break;
        blockLines.push(candidate.trimStart());
        next += 1;
      }
      const command = blockHeader[1] === ">"
        ? blockLines.map((entry) => entry.trim()).join(" ")
        : blockLines.join("\n");
      if (command.trim() === "" || hasDirectPackageManagerCommand(command)) {
        findings.push({ line: index + 1, command: scalar.trim() });
      }
      index = next - 1;
      continue;
    }

    if (workflowScalarHasBypass(scalar)) {
      findings.push({ line: index + 1, command: scalar.trim() });
    }
    let next = index + 1;
    while (next < lines.length && (lines[next].trim() === "" || lines[next].trimStart().startsWith("#"))) {
      next += 1;
    }
    const nextLine = lines[next];
    if (
      nextLine !== undefined
      && scalar.trim() !== ""
      && nextLine.match(/^\s*/)[0].length > mappingIndent
    ) {
      findings.push({ line: index + 1, command: "unsupported YAML plain scalar continuation" });
    }
  }
  return findings;
}
