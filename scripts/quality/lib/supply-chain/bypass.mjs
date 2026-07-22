import { posix as posixPath } from "node:path";

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

const SHELL_COMMANDS = new Set([
  "ash",
  "bash",
  "dash",
  "hush",
  "rbash",
  "sh",
  "zsh",
]);

function splitShellSegments(text) {
  const segments = [];
  let buffer = "";
  let quote = null;
  let escaped = false;
  const appendSegment = () => {
    if (buffer.trim() === "") {
      buffer = "";
      return;
    }
    segments.push(buffer);
    buffer = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      buffer += character;
      escaped = false;
      continue;
    }
    if (
      character === "\\"
      && quote !== "'"
      && (
        text[index + 1] === "\n"
        || (text[index + 1] === "\r" && text[index + 2] === "\n")
      )
    ) {
      index += text[index + 1] === "\r" ? 2 : 1;
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
      appendSegment();
      continue;
    }
    if (character === "|") {
      if (text[index + 1] === "|") {
        appendSegment();
        index += 1;
      } else {
        appendSegment();
        if (text[index + 1] === "&") index += 1;
      }
      continue;
    }
    if (character === "&") {
      if ((buffer.endsWith("<") || buffer.endsWith(">")) && text[index + 1] !== "&") {
        buffer += character;
        continue;
      }
      appendSegment();
      if (text[index + 1] === "&") index += 1;
      continue;
    }
    if (character === ";") {
      appendSegment();
      continue;
    }
    if (character === "\n") {
      appendSegment();
      continue;
    }
    buffer += character;
  }
  appendSegment();
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
    if (character === "<" || character === ">" || character === "(" || character === ")") {
      if (tokenStarted) tokens.push(token);
      tokens.push(character);
      token = "";
      tokenStarted = false;
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

function tokenHasUnprovenShellExpansion(token) {
  return token.includes("$")
    || token.includes("`")
    || /[?*[\]{}]/u.test(token)
    || token.startsWith("<(")
    || token.startsWith(">(");
}

function assignVariable(variables, name, operator, rawValue) {
  const resolved = resolveVariable(rawValue, variables);
  const value = resolved ?? rawValue;
  if (operator === "+=") {
    const current = variables.get(name);
    variables.set(name, typeof current === "string" ? `${current}${value}` : null);
    return;
  }
  variables.set(name, value);
}

function consumeAssignments(tokens, start, variables) {
  let index = start;
  while (index < tokens.length) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)(.*)$/.exec(tokens[index]);
    if (!match) break;
    assignVariable(variables, match[1], match[2], match[3]);
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

function containsUnprovenProcessOrLegacySubstitution(text) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "`") return true;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(text[index - 1]))) {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "`") return true;
    if (["<", ">"].includes(character) && text[index + 1] === "(") return true;
  }
  return false;
}

function consumeRedirection(tokens, start) {
  let index = start;
  if (/^\d+$/.test(tokens[index] ?? "") && ["<", ">"].includes(tokens[index + 1])) {
    index += 1;
  }
  const direction = tokens[index];
  if (direction !== "<" && direction !== ">") return null;
  while (tokens[index] === "<" || tokens[index] === ">") index += 1;
  if (index < tokens.length) index += 1;
  return { index };
}

function consumeCommandPrefix(tokens, start, variables) {
  let index = start;
  while (index < tokens.length) {
    const assignmentEnd = consumeAssignments(tokens, index, variables);
    if (assignmentEnd !== index) {
      index = assignmentEnd;
      continue;
    }
    const redirection = consumeRedirection(tokens, index);
    if (redirection !== null) {
      index = redirection.index;
      continue;
    }
    if (["(", "{", "!"].includes(tokens[index])) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function consumeWrapperInvocation(wrapper, tokens, start) {
  let index = start;
  const consumeOptions = (valueOptions, isUnsafe = () => false) => {
    while (index < tokens.length && tokens[index].startsWith("-") && tokens[index] !== "-") {
      const option = tokens[index];
      if (isUnsafe(option)) return true;
      if (option === "--") {
        index += 1;
        break;
      }
      index += valueOptions.has(option) ? 2 : 1;
    }
    return false;
  };

  if (wrapper === "command") {
    let lookupOnly = false;
    while (index < tokens.length && tokens[index].startsWith("-") && tokens[index] !== "-") {
      const option = tokens[index];
      if (option === "--") {
        index += 1;
        break;
      }
      if (/^-[^-]*[vV]/u.test(option)) lookupOnly = true;
      index += 1;
    }
    return { index, terminal: lookupOnly, unsafe: false };
  }
  if (wrapper === "env") {
    while (index < tokens.length && tokens[index].startsWith("-") && tokens[index] !== "-") {
      const option = tokens[index];
      if (option === "--") {
        index += 1;
        break;
      }
      if (/^-[^-]*S/u.test(option) || option.startsWith("--s")) {
        return { index, unsafe: true };
      }
      index += ["-u", "--unset", "-C", "--chdir"].includes(option) ? 2 : 1;
    }
  } else if (wrapper === "exec") {
    consumeOptions(new Set(["-a"]));
  } else if (wrapper === "timeout") {
    consumeOptions(new Set(["-k", "--kill-after", "-s", "--signal"]));
    if (index < tokens.length) index += 1;
  } else if (wrapper === "sudo") {
    const unsafe = consumeOptions(new Set([
      "-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host",
      "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-T",
      "--command-timeout", "-t", "--type", "-u", "--user",
    ]), (option) => (
      ["--login", "--shell"].includes(option)
      || (/^-[^-]*[is]/u.test(option) && option !== "-S")
    ));
    if (unsafe) return { index, unsafe: true };
  } else if (wrapper === "nice") {
    consumeOptions(new Set(["-n", "--adjustment"]));
  } else if (wrapper === "time") {
    consumeOptions(new Set(["-f", "--format", "-o", "--output"]));
  } else if (wrapper === "stdbuf") {
    consumeOptions(new Set(["-i", "--input", "-o", "--output", "-e", "--error"]));
  } else {
    consumeOptions(new Set());
  }
  return { index, terminal: false, unsafe: false };
}

function commandArguments(tokens, commandIndex) {
  const args = [];
  for (let index = commandIndex + 1; index < tokens.length;) {
    if (["<", ">"].includes(tokens[index]) && tokens[index + 1] === "(") {
      args.push(`${tokens[index]}(`);
      index += 2;
      continue;
    }
    const redirection = consumeRedirection(tokens, index);
    if (redirection !== null) {
      index = redirection.index;
      continue;
    }
    if ([")", "}"].includes(tokens[index])) {
      index += 1;
      continue;
    }
    args.push(tokens[index]);
    index += 1;
  }
  return args;
}

function commandSourcePathIsDynamicOrStdin(value) {
  const normalized = value.startsWith("/") ? posixPath.normalize(value) : value;
  return normalized === "-"
    || normalized === "/dev/stdin"
    || normalized.startsWith("/dev/stdin/")
    || normalized.startsWith("/dev/fd/")
    || /^\/proc\/(?:self|thread-self|[1-9]\d*)\/fd(?:\/|$)/u.test(normalized);
}

function commandSourceIsDynamicOrStdin(token, variables) {
  if (typeof token !== "string") return true;
  const resolved = resolveVariable(token, variables);
  if (resolved === null) return true;
  if (resolved === "" || resolved === "/dev/null") return false;
  return commandSourcePathIsDynamicOrStdin(resolved)
    || tokenHasUnprovenShellExpansion(resolved);
}

function expandKnownSimpleVariables(value, variables, active = new Set()) {
  let unresolved = false;
  const expanded = value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
    (token, bracedName, bareName) => {
      const name = bracedName ?? bareName;
      const known = variables.get(name);
      if (typeof known !== "string" || active.has(name)) {
        unresolved = true;
        return token;
      }
      const nested = expandKnownSimpleVariables(known, variables, new Set([...active, name]));
      if (nested.unresolved) unresolved = true;
      return nested.value;
    },
  );
  return { unresolved, value: expanded };
}

function sourceExpressionMayReadDynamicInput(token, variables) {
  if (typeof token !== "string") return true;
  const initial = resolveVariable(token, variables);
  if (initial === null) return true;
  const expanded = expandKnownSimpleVariables(initial, variables);
  const resolved = expanded.value;
  if (resolved === "" || resolved === "/dev/null") return false;
  if (commandSourcePathIsDynamicOrStdin(resolved)) return true;
  if (!expanded.unresolved && !resolved.includes("$")) {
    return tokenHasUnprovenShellExpansion(resolved);
  }

  const simpleVariable = /\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/gu;
  const fragments = [];
  let skeleton = "";
  let offset = 0;
  for (const match of resolved.matchAll(simpleVariable)) {
    const literal = resolved.slice(offset, match.index);
    fragments.push(literal);
    skeleton += literal;
    offset = match.index + match[0].length;
  }
  const suffix = resolved.slice(offset);
  fragments.push(suffix);
  skeleton += suffix;
  if (
    skeleton.includes("$")
    || tokenHasUnprovenShellExpansion(skeleton)
    || skeleton.includes("//")
    || /(?:^|\/)\.{1,2}(?:\/|$)/u.test(skeleton)
  ) {
    return true;
  }
  const finalFragment = fragments.at(-1);
  return finalFragment === ""
    || "-".endsWith(finalFragment)
    || "/dev/stdin".endsWith(finalFragment)
    || /\d$/u.test(finalFragment);
}

function shellStartupSourceIsUnsafe(variables) {
  return ["BASH_ENV", "ENV"].some((name) => (
    variables.has(name)
    && commandSourceIsDynamicOrStdin(variables.get(name), variables)
  ));
}

function shellInvokesPackageManagerOrReadsCommandsFromStdin(tokens, shellIndex, variables) {
  const args = commandArguments(tokens, shellIndex);
  if (shellStartupSourceIsUnsafe(variables)) return true;
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === "--") {
      index += 1;
      break;
    }
    if (["--help", "--version"].includes(argument)) return false;
    if (argument === "-" || argument === "--stdin") return true;
    if (!argument.startsWith("-") && !argument.startsWith("+")) break;
    const sourceOption = ["--init-file", "--rcfile"].find((option) => (
      argument === option || argument.startsWith(`${option}=`)
    ));
    if (sourceOption !== undefined) {
      const source = argument === sourceOption
        ? args[index + 1]
        : argument.slice(sourceOption.length + 1);
      if (commandSourceIsDynamicOrStdin(source, variables)) return true;
      index += argument === sourceOption ? 2 : 1;
      continue;
    }
    if (argument.startsWith("-") && /^-[^-]*c/.test(argument)) {
      return args[index + 1] === undefined
        ? false
        : hasDirectPackageManagerCommand(args[index + 1]);
    }
    if (argument.startsWith("-") && /^-[^-]*s/.test(argument)) return true;
    index += ["-O", "+O", "-o", "--rcfile", "--init-file"].includes(argument) ? 2 : 1;
  }

  const script = args[index];
  if (script === undefined) return true;
  return commandSourceIsDynamicOrStdin(script, variables);
}

function sourceReadsCommandsFromDynamicInput(tokens, sourceIndex, variables) {
  const args = commandArguments(tokens, sourceIndex);
  let index = 0;
  while (args[index]?.startsWith("-") && args[index] !== "-") {
    if (args[index] === "--") {
      index += 1;
      break;
    }
    index += 1;
  }
  return args[index] !== undefined
    && sourceExpressionMayReadDynamicInput(args[index], variables);
}

function updateVariablesFromBuiltin(name, tokens, commandIndex, variables) {
  if (name === "unset") {
    let deleteVariables = true;
    let optionsComplete = false;
    for (const token of tokens.slice(commandIndex + 1)) {
      if (!optionsComplete && token === "--") {
        optionsComplete = true;
        continue;
      }
      if (!optionsComplete && token.startsWith("-")) {
        deleteVariables = /^-[^-]*v/u.test(token);
        continue;
      }
      if (deleteVariables && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(token)) {
        variables.delete(token);
      }
    }
    return true;
  }
  if (!["declare", "export", "readonly", "typeset"].includes(name)) return false;
  for (const token of tokens.slice(commandIndex + 1)) {
    if (token.startsWith("-")) continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)(?:(\+?=)(.*))?$/u.exec(token);
    if (!assignment) continue;
    if (assignment[2] === undefined) variables.set(assignment[1], null);
    else assignVariable(variables, assignment[1], assignment[2], assignment[3]);
  }
  return true;
}

function dynamicExecutorInvokesPackageManagerOrShell(name, tokens, commandIndex, variables) {
  if (name === "xargs") {
    const valueOptions = new Set([
      "-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace",
      "-L", "--max-lines", "-n", "--max-args", "-P", "--max-procs", "-s",
      "--max-chars", "--process-slot-var",
    ]);
    let index = commandIndex + 1;
    while (index < tokens.length && tokens[index].startsWith("-") && tokens[index] !== "-") {
      const option = tokens[index];
      if (option === "--") {
        index += 1;
        break;
      }
      index += valueOptions.has(option) ? 2 : 1;
    }
    if (index >= tokens.length) return false;
    return segmentInvokesPackageManager(tokens.slice(index).join(" "), new Map(variables));
  }
  if (name !== "find") return false;
  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(tokens[index])) continue;
    const end = tokens.findIndex((token, tokenIndex) => (
      tokenIndex > index && (token === ";" || token === "+")
    ));
    const invocation = tokens.slice(index + 1, end === -1 ? tokens.length : end).join(" ");
    if (invocation !== "" && segmentInvokesPackageManager(invocation, new Map(variables))) {
      return true;
    }
    if (end !== -1) index = end;
  }
  return false;
}

function compoundCommandInvokesPackageManagerOrShell(text) {
  let caseDepth = 0;
  for (const segment of splitShellSegments(text)) {
    const tokens = tokenizeShellSegment(segment);
    let index = 0;
    while (["!", "do", "else", "then", "{"].includes(tokens[index])) index += 1;
    if (tokens[index] === "case") caseDepth += 1;
    if (caseDepth > 0) {
      const caseBody = tokens.lastIndexOf(")") + 1;
      if (caseBody > index) index = caseBody;
    }
    if (
      index > 0
      && index < tokens.length
      && segmentInvokesPackageManager(tokens.slice(index).join(" "), new Map())
    ) {
      return true;
    }
    if (tokens.includes("esac") && caseDepth > 0) caseDepth -= 1;
  }
  return false;
}

function segmentInvokesPackageManager(segment, variables) {
  const tokens = tokenizeShellSegment(segment);
  if (tokens.some((token, index) => (
    ["<", ">"].includes(token) && tokens[index + 1] === "("
  ))) {
    return true;
  }
  let index = consumeCommandPrefix(tokens, 0, variables);
  if (index >= tokens.length) return false;

  let command = resolveVariable(tokens[index], variables);
  if (command === null) return true;
  if (tokenHasUnprovenShellExpansion(command)) return true;
  let name = commandBasename(command);

  while ([
    "builtin", "busybox", "command", "env", "exec", "nice", "nohup", "setsid", "stdbuf",
    "sudo", "time", "timeout", "toybox",
  ].includes(name)) {
    const wrapper = name;
    const wrapped = consumeWrapperInvocation(wrapper, tokens, index + 1);
    if (wrapped.unsafe) return true;
    if (wrapped.terminal) return false;
    index = consumeCommandPrefix(tokens, wrapped.index, variables);
    if (index >= tokens.length) return false;
    command = resolveVariable(tokens[index], variables);
    if (command === null) return true;
    if (tokenHasUnprovenShellExpansion(command)) return true;
    name = commandBasename(command);
  }

  if (updateVariablesFromBuiltin(name, tokens, index, variables)) return false;
  if (name === "alias" || name === "unalias") return true;
  if (tokenMayNamePackageManager(command)) return true;
  if (dynamicExecutorInvokesPackageManagerOrShell(name, tokens, index, variables)) return true;
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
  if (name === "." || name === "source") {
    return sourceReadsCommandsFromDynamicInput(tokens, index, variables);
  }
  if (SHELL_COMMANDS.has(name)) {
    return shellInvokesPackageManagerOrReadsCommandsFromStdin(tokens, index, variables);
  }
  return false;
}

export function hasDirectPackageManagerCommand(text) {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (containsUnprovenProcessOrLegacySubstitution(text)) return true;
  if (containsCommandSubstitution(text)) return true;
  if (compoundCommandInvokesPackageManagerOrShell(text)) return true;
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
        containsUnprovenProcessOrLegacySubstitution(line)
        ||
        containsCommandSubstitution(line)
        || splitShellSegments(line).some((segment) => segmentInvokesPackageManager(segment, variables))
      )
    ) {
      findings.push({ line: index + 1, command: trimmed });
    }
  }
  if (findings.length === 0 && hasDirectPackageManagerCommand(text)) {
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    findings.push({
      line: index === -1 ? 1 : index + 1,
      command: "multi-line shell command",
    });
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

function stripWorkflowScalarComment(scalar) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < scalar.length; index += 1) {
    const character = scalar[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "'" && character === "'" && scalar[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "#" && (index === 0 || /\s/u.test(scalar[index - 1]))) {
      return scalar.slice(0, index).trimEnd();
    }
  }
  return scalar;
}

function workflowEnvironmentSourceIsUnsafe(scalar) {
  const trimmed = stripWorkflowScalarComment(scalar).trim();
  if (/^[|>[{]/u.test(trimmed)) return true;
  const decoded = decodeWorkflowScalar(trimmed);
  return decoded === null || commandSourceIsDynamicOrStdin(decoded, new Map());
}

function workflowMappingKey(line) {
  const trimmed = line.trimStart();
  let quote = null;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "'" && character === "'" && trimmed[index + 1] === "'") {
      index += 1;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ":" && (trimmed[index + 1] === undefined || /\s/u.test(trimmed[index + 1]))) {
      return trimmed.slice(0, index).trim();
    }
  }
  return null;
}

function workflowSimpleMappingKey(line) {
  const key = workflowMappingKey(line);
  if (key === null) return null;
  return decodeWorkflowScalar(key.replace(/^-\s+/u, ""));
}

function workflowLineIsWithinMapping(lines, index, expectedKey) {
  let childIndent = lines[index].match(/^\s*/)[0].length;
  for (let previous = index - 1; previous >= 0; previous -= 1) {
    const candidate = lines[previous];
    if (candidate.trim() === "" || candidate.trimStart().startsWith("#")) continue;
    const indentation = candidate.match(/^\s*/)[0].length;
    if (indentation >= childIndent) continue;
    if (workflowSimpleMappingKey(candidate) === expectedKey) return true;
    childIndent = indentation;
  }
  return false;
}

function inspectWorkflowEnvironment(lines, start, environment) {
  const findings = [];
  const scalar = stripWorkflowScalarComment(environment[3]).trim();
  if (scalar !== "") {
    findings.push({ line: start + 1, command: "unsupported YAML env mapping" });
    return { findings, next: start };
  }

  const mappingIndent = environment[1].length + (environment[2]?.length ?? 0);
  let next = start + 1;
  while (next < lines.length) {
    const candidate = lines[next];
    const trimmed = candidate.trim();
    const indentation = candidate.match(/^\s*/)[0].length;
    if (trimmed !== "" && indentation <= mappingIndent) break;
    if (trimmed === "" || candidate.trimStart().startsWith("#")) {
      next += 1;
      continue;
    }

    const startupEnvironment = /^\s*(?:"(?:BASH_ENV|ENV)"|'(?:BASH_ENV|ENV)'|(?:BASH_ENV|ENV))\s*:\s*(.*)$/.exec(candidate);
    const mappingKey = workflowMappingKey(candidate);
    if (startupEnvironment) {
      if (workflowEnvironmentSourceIsUnsafe(startupEnvironment[1])) {
        findings.push({ line: next + 1, command: "unsafe shell startup environment" });
      }
    } else if (
      /^\s*(?:\?|<<\s*:)/u.test(candidate)
      || /^\s*"[^"]*\\[^"]*"\s*:/u.test(candidate)
      || (
        mappingKey !== null
        && /(?:^|[^A-Za-z0-9_])(?:BASH_ENV|ENV)(?:[^A-Za-z0-9_]|$)/u.test(mappingKey)
      )
    ) {
      findings.push({ line: next + 1, command: "unsupported YAML env mapping" });
    }
    next += 1;
  }
  return { findings, next: next - 1 };
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
    const insideWith = workflowLineIsWithinMapping(lines, index, "with");
    if (/^\s*(?:-\s*)?\?/u.test(line) && !insideWith) {
      findings.push({ line: index + 1, command: "unsupported YAML explicit mapping key" });
      continue;
    }
    if (
      !insideWith
      && (
        /^\s*(?:-\s+)?(?:[&!][^\s:]+\s+)+(?:"env"|'env'|env)\s*:/u.test(line)
        || /^\s*(?:-\s+)?\*[^\s:]+\s*:/u.test(line)
      )
    ) {
      findings.push({ line: index + 1, command: "unsupported YAML env mapping key" });
      continue;
    }
    const environment = /^(\s*)(?:(-\s+))?(?:"env"|'env'|env)\s*:\s*(.*)$/.exec(line);
    if (environment) {
      if (insideWith || workflowLineIsWithinMapping(lines, index, "env")) continue;
      const inspected = inspectWorkflowEnvironment(lines, index, environment);
      findings.push(...inspected.findings);
      index = inspected.next;
      continue;
    }
    const run = /^(\s*)(?:(-\s+))?(?:"run"|'run'|run)\s*:\s*(.*)$/.exec(line);
    if (!run) {
      if (
        /^\s*(?:-\s*)?(?:[A-Za-z_][A-Za-z0-9_-]*\s*:\s*)?[\[{]/.test(line)
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
