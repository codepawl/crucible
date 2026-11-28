// Normalizes MCP tool JSON Schemas at `tools/list` time for stricter client validators (Gemini, OpenAI strict)
// while keeping default/Claude schemas and server-side Zod runtime validation unchanged.

export const SCHEMA_COMPAT_PROFILES = Object.freeze(['auto', 'off', 'gemini', 'openai-strict']);

const ANNOTATION_KEYS = new Set(['description', 'title', 'default', '$comment', 'examples']);
const TYPE_KEYS = ['type', '$ref', 'anyOf', 'oneOf', 'allOf', 'const', 'enum', 'not'];
const OPENAI_STRICT_DROP_KEYWORDS = new Set([
  '$schema', 'oneOf', 'allOf', 'not', 'dependentRequired', 'dependentSchemas',
  'if', 'then', 'else', 'prefixItems', 'propertyNames', 'patternProperties',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength',
  'maxLength', 'minItems', 'maxItems', 'pattern', 'format', 'uniqueItems',
]);
const GEMINI_DROP_KEYWORDS = new Set([
  '$schema', '$defs', '$ref', 'const', 'oneOf', 'allOf', 'not',
  'prefixItems', 'propertyNames', 'patternProperties', 'uniqueItems',
  'exclusiveMinimum', 'exclusiveMaximum',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyOrAnnotationOnly(node) {
  return isPlainObject(node) && Object.keys(node).every(key => ANNOTATION_KEYS.has(key));
}

function copyAnnotations(source) {
  const result = {};
  for (const key of ANNOTATION_KEYS) {
    if (key in source) result[key] = source[key];
  }
  return result;
}

/** Pick the compatibility profile matching an MCP client `clientInfo.name`. */
export function detectSchemaCompatProfile(clientName) {
  if (typeof clientName !== 'string' || !clientName) return 'off';
  if (/gemini|antigravity|google/i.test(clientName)) return 'gemini';
  if (/openai|chatgpt/i.test(clientName)) return 'openai-strict';
  return 'off';
}

function resolveRef(reference, definitions, visited) {
  if (typeof reference !== 'string') return undefined;
  const prefix = '#/$defs/';
  if (!reference.startsWith(prefix)) return undefined;
  const name = reference.slice(prefix.length);
  if (visited.has(name)) return { type: 'object', description: `Recursive reference to ${name}.` };
  return definitions?.[name];
}

function inferredLiteralType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function collapseTuplePrefixItems(prefixItems) {
  const seenTypes = new Set();
  const variants = [];
  for (const element of prefixItems) {
    const serialized = JSON.stringify(element);
    if (!seenTypes.has(serialized)) {
      seenTypes.add(serialized);
      variants.push(element);
    }
  }
  if (variants.length === 0) return { type: 'number' };
  if (variants.length === 1) return variants[0];
  return { anyOf: variants };
}

function appendConstraintNote(node, note) {
  if (!note) return;
  node.description = node.description ? `${node.description} (${note})` : note;
}

function normalizeNodeForGemini(node, definitions, visited) {
  if (!isPlainObject(node)) return node;
  if ('$ref' in node) {
    const refName = typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/') ? node.$ref.slice('#/$defs/'.length) : null;
    const target = resolveRef(node.$ref, definitions, visited);
    if (target) {
      const nextVisited = new Set(visited);
      if (refName) nextVisited.add(refName);
      const inlined = normalizeNodeForGemini(target, definitions, nextVisited);
      return { ...inlined, ...copyAnnotations(node) };
    }
  }
  if (isEmptyOrAnnotationOnly(node)) {
    return { type: 'object', ...copyAnnotations(node) };
  }
  const output = {};
  const extraNotes = [];
  for (const [key, value] of Object.entries(node)) {
    if (GEMINI_DROP_KEYWORDS.has(key)) continue;
    output[key] = value;
  }
  if ('const' in node) {
    output.enum = [node.const];
    if (!output.type) output.type = inferredLiteralType(node.const);
  }
  if ('oneOf' in node && Array.isArray(node.oneOf)) {
    const normalizedVariants = node.oneOf.map(variant => normalizeNodeForGemini(variant, definitions, visited));
    output.anyOf = output.anyOf ? [...output.anyOf, ...normalizedVariants] : normalizedVariants;
  }
  if ('allOf' in node && Array.isArray(node.allOf)) {
    const mergedProperties = { ...(output.properties ?? {}) };
    const mergedRequired = new Set(output.required ?? []);
    for (const part of node.allOf) {
      const normalizedPart = normalizeNodeForGemini(part, definitions, visited);
      if (normalizedPart?.type && !output.type) output.type = normalizedPart.type;
      if (isPlainObject(normalizedPart?.properties)) Object.assign(mergedProperties, normalizedPart.properties);
      for (const req of normalizedPart?.required ?? []) mergedRequired.add(req);
    }
    if (Object.keys(mergedProperties).length > 0) output.properties = mergedProperties;
    if (mergedRequired.size > 0) output.required = [...mergedRequired];
  }
  if ('exclusiveMinimum' in node && typeof node.exclusiveMinimum === 'number') {
    if (!('minimum' in output)) output.minimum = node.exclusiveMinimum;
    extraNotes.push(`must be > ${node.exclusiveMinimum}`);
  }
  if ('exclusiveMaximum' in node && typeof node.exclusiveMaximum === 'number') {
    if (!('maximum' in output)) output.maximum = node.exclusiveMaximum;
    extraNotes.push(`must be < ${node.exclusiveMaximum}`);
  }
  if ('prefixItems' in node && Array.isArray(node.prefixItems)) {
    const normalizedItems = node.prefixItems.map(item => normalizeNodeForGemini(item, definitions, visited));
    output.items = collapseTuplePrefixItems(normalizedItems);
    if (output.minItems === undefined) output.minItems = normalizedItems.length;
    if (output.maxItems === undefined) output.maxItems = normalizedItems.length;
  } else if (isPlainObject(output.items)) {
    output.items = normalizeNodeForGemini(output.items, definitions, visited);
  }
  if (Array.isArray(output.anyOf)) {
    output.anyOf = output.anyOf.map(variant => normalizeNodeForGemini(variant, definitions, visited));
  }
  if (isPlainObject(output.properties)) {
    const mappedProperties = {};
    for (const [propertyName, propertySchema] of Object.entries(output.properties)) {
      mappedProperties[propertyName] = normalizeNodeForGemini(propertySchema, definitions, visited);
    }
    output.properties = mappedProperties;
    if (!output.type) output.type = 'object';
  }
  if ('additionalProperties' in output) {
    if (output.additionalProperties === true || output.additionalProperties === false) {
      // Keep boolean additionalProperties as-is; avoids visiting an empty schema object.
    } else if (isPlainObject(output.additionalProperties)) {
      const normalizedAdditional = normalizeNodeForGemini(output.additionalProperties, definitions, visited);
      output.additionalProperties = isEmptyOrAnnotationOnly(output.additionalProperties) ? true : normalizedAdditional;
    }
  }
  if (!TYPE_KEYS.some(key => key in output)) {
    output.type = 'object';
  }
  if (extraNotes.length > 0) appendConstraintNote(output, extraNotes.join(', '));
  return output;
}

function makeNullable(schema) {
  if (!isPlainObject(schema)) return schema;
  if (Array.isArray(schema.type)) {
    return schema.type.includes('null') ? schema : { ...schema, type: [...schema.type, 'null'] };
  }
  if (schema.type === 'null') return schema;
  if (Array.isArray(schema.anyOf)) {
    const hasNull = schema.anyOf.some(item => isPlainObject(item) && item.type === 'null');
    return hasNull ? schema : { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

function normalizeNodeForOpenAiStrict(node, definitions, visited) {
  if (!isPlainObject(node)) return node;
  if ('$ref' in node) {
    const refName = typeof node.$ref === 'string' && node.$ref.startsWith('#/$defs/') ? node.$ref.slice('#/$defs/'.length) : null;
    const target = resolveRef(node.$ref, definitions, visited);
    if (target) {
      const nextVisited = new Set(visited);
      if (refName) nextVisited.add(refName);
      const inlined = normalizeNodeForOpenAiStrict(target, definitions, nextVisited);
      return { ...inlined, ...copyAnnotations(node) };
    }
  }
  if (isEmptyOrAnnotationOnly(node)) {
    return { type: 'string', ...copyAnnotations(node) };
  }
  const output = {};
  for (const [key, value] of Object.entries(node)) {
    if (OPENAI_STRICT_DROP_KEYWORDS.has(key) || key === '$defs') continue;
    output[key] = value;
  }
  if ('const' in node) {
    output.enum = [node.const];
    if (!output.type) output.type = inferredLiteralType(node.const);
    delete output.const;
  }
  if ('oneOf' in node && Array.isArray(node.oneOf)) {
    const normalizedVariants = node.oneOf.map(variant => normalizeNodeForOpenAiStrict(variant, definitions, visited));
    output.anyOf = output.anyOf ? [...output.anyOf, ...normalizedVariants] : normalizedVariants;
  }
  if ('prefixItems' in node && Array.isArray(node.prefixItems)) {
    const normalizedItems = node.prefixItems.map(item => normalizeNodeForOpenAiStrict(item, definitions, visited));
    output.items = collapseTuplePrefixItems(normalizedItems);
  } else if (isPlainObject(output.items)) {
    output.items = normalizeNodeForOpenAiStrict(output.items, definitions, visited);
  }
  if (Array.isArray(output.anyOf)) {
    output.anyOf = output.anyOf.map(variant => normalizeNodeForOpenAiStrict(variant, definitions, visited));
  }
  if (isPlainObject(output.properties)) {
    const requiredSet = new Set(output.required ?? []);
    const mappedProperties = {};
    for (const [propertyName, propertySchema] of Object.entries(output.properties)) {
      const normalizedProperty = normalizeNodeForOpenAiStrict(propertySchema, definitions, visited);
      mappedProperties[propertyName] = requiredSet.has(propertyName) ? normalizedProperty : makeNullable(normalizedProperty);
    }
    output.properties = mappedProperties;
    output.required = Object.keys(mappedProperties);
    output.additionalProperties = false;
    if (!output.type) output.type = 'object';
  } else if (output.type === 'object') {
    output.additionalProperties = false;
  }
  if (!TYPE_KEYS.some(key => key in output)) {
    output.type = 'string';
  }
  return output;
}

/**
 * Normalize one tool's JSON Schema for the requested compatibility profile (`'off'`, `'gemini'`, `'openai-strict'`).
 * Returns the input unchanged when profile is `'off'`.
 */
export function normalizeToolSchema(schema, profile = 'off') {
  if (!isPlainObject(schema) || profile === 'off' || profile === 'auto') return schema;
  const definitions = isPlainObject(schema.$defs) ? schema.$defs : {};
  if (profile === 'gemini') {
    return normalizeNodeForGemini(schema, definitions, new Set());
  }
  if (profile === 'openai-strict') {
    const normalized = normalizeNodeForOpenAiStrict(schema, definitions, new Set());
    if (Array.isArray(normalized.anyOf)) {
      delete normalized.anyOf;
      normalized.type = 'object';
      normalized.properties ??= {};
      normalized.required ??= [];
      normalized.additionalProperties = false;
    }
    return normalized;
  }
  throw new RangeError(`Unknown schema compatibility profile: ${profile}. Use ${SCHEMA_COMPAT_PROFILES.join(', ')}.`);
}

/** Transform a `tools/list` array for the given client compatibility profile. */
export function normalizeToolsList(tools, profile = 'off') {
  if (profile === 'off' || profile === 'auto') return tools;
  return tools.map(tool => ({
    ...tool,
    ...(tool.inputSchema ? { inputSchema: normalizeToolSchema(tool.inputSchema, profile) } : {}),
  }));
}
