export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const multiValueOptions = new Set(config.multiValueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  function setValue(key, value) {
    if (multiValueOptions.has(key)) {
      options[key] = [...(options[key] ?? []), value];
    } else {
      options[key] = value;
    }
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (passthrough) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const isLong = token.startsWith("--");
    const raw = isLong ? token.slice(2) : token.slice(1);
    const [rawKey, inlineValue] = isLong ? raw.split("=", 2) : [raw, undefined];
    const key = aliasMap[rawKey] ?? rawKey;

    if (booleanOptions.has(key)) {
      options[key] = inlineValue === undefined ? true : inlineValue !== "false";
      continue;
    }
    if (valueOptions.has(key) || multiValueOptions.has(key)) {
      const nextValue = inlineValue ?? argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for ${isLong ? "--" : "-"}${rawKey}`);
      }
      setValue(key, nextValue);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    if (config.rejectUnknownOptions) {
      throw new Error(`Unknown option: ${token}`);
    }
    positionals.push(token);
  }

  return { options, positionals };
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
