// scene_capabilities answers with a short index and serves the detail by topic, so the tool schemas stay small.
// A topic is a key of the scene capabilities, a runtime section (jobs, assets, ...) or the outline of a full input schema
// (motion, environment, meshEdit, ...). A union such as meshEdit takes a branch: meshEdit.bevel.
import * as z from 'zod/v4';
import { compactType, outlineSchema, unionBranches } from './schema-outline.mjs';
import { AGENT_TOOL_EXAMPLES } from './tool-examples.mjs';
import { MODIFIER_OPERATIONS } from '../src/mesh-operations.js';

const RUNTIME_SECTIONS = ['sceneLimits', 'preview', 'review', 'wedge', 'assets', 'packs', 'jobs', 'export', 'addons', 'unsupported'];
const SUMMARY_LENGTH = 110;
// Scalars (booleans and numbers) of the scene capabilities share one topic instead of one each.
const FLAGS_TOPIC = 'flags';

function isScalar(value) {
  return typeof value === 'boolean' || typeof value === 'number';
}

function firstSentence(text = '') {
  const sentence = text.split(/\.\s/)[0].replace(/\.$/, '');
  return sentence.length > SUMMARY_LENGTH ? `${sentence.slice(0, SUMMARY_LENGTH - 1)}…` : sentence;
}

function sceneTopics(scene) {
  const topics = new Map();
  const flags = {};
  for (const [name, value] of Object.entries(scene)) {
    if (isScalar(value)) flags[name] = value;
    else topics.set(name, value);
  }
  topics.set('examples', AGENT_TOOL_EXAMPLES);
  topics.set(FLAGS_TOPIC, flags);
  return topics;
}

function inputJsonSchema(schema) {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
}

const RULE_KINDS = /^(Face|Edge|Vertex) rule/;

/** A rule argument (select, edges, verts) is typed faceRule, edgeRule or vertexRule, so the answer can state each rule once. */
function argumentType(property, definitions) {
  const kind = RULE_KINDS.exec(property.description ?? '');
  return kind ? `${kind[1].toLowerCase()}Rule` : compactType(property, definitions);
}

/** One line of arguments for a branch: "width:number, segments?:int[1..16]"; ? marks an optional one, the discriminator is left out. */
function branchArguments(branch, definitions) {
  const required = new Set(branch.required ?? []);
  return Object.entries(branch.properties ?? {})
    .filter(([, property]) => property.const === undefined)
    .map(([name, property]) => `${name}${required.has(name) ? '' : '?'}:${argumentType(property, definitions)}`)
    .join(', ');
}

function branchSummary(branch, definitions) {
  return { args: branchArguments(branch, definitions), ...(branch.description ? { note: firstSentence(branch.description) } : {}) };
}

/** Each rule type once, from the first branch that spells it out, so a rule is not repeated for every op that takes it. */
function ruleLegend(branches) {
  const legend = {};
  for (const branch of branches.values()) {
    for (const property of Object.values(branch.properties ?? {})) {
      const kind = /^(Face|Edge|Vertex) rule:/.exec(property.description ?? '');
      const name = kind ? `${kind[1].toLowerCase()}Rule` : undefined;
      if (name && legend[name] === undefined) legend[name] = property.description;
    }
  }
  return legend;
}

function unionIndex(topic, branches, definitions = {}) {
  const entries = {};
  for (const [name, branch] of branches) entries[name] = branchSummary(branch, definitions);
  const rules = ruleLegend(branches);
  return {
    branches: entries,
    ...(Object.keys(rules).length ? { rules } : {}),
    use: `args are name:type, ?=optional; topic ${topic}.<name> for one branch's field notes; modifier ops not listed here are in meshModifiers${topic === 'meshEdit' ? '; vertex indices are of the mesh just before that edit' : ''}`,
  };
}

// The mesh_edit and mesh_stack ops that take whole-mesh modifier fields (wave, ocean, ...) have no branch of their own: meshModifiers.<op> serves them.
const MODIFIER_TOPICS = new Set(['meshEdit', 'meshStack']);

function modifierPointer(topic) {
  return { modifierOps: Object.keys(MODIFIER_OPERATIONS), modifierUse: `${topic} also takes every op in modifierOps; topic meshModifiers.<op> gives its fields` };
}

function outlineAnswer(topic, branchName, schema) {
  const jsonSchema = inputJsonSchema(schema);
  const branches = unionBranches(jsonSchema);
  const withDefinitions = part => ({ ...part, ...(jsonSchema.$defs ? { $defs: jsonSchema.$defs } : {}) });
  if (!branchName) {
    if (!branches) return outlineSchema(jsonSchema);
    return { ...unionIndex(topic, branches, jsonSchema.$defs), ...(MODIFIER_TOPICS.has(topic) ? modifierPointer(topic) : {}) };
  }
  if (branches?.has(branchName)) return outlineSchema(withDefinitions(branches.get(branchName)));
  // A short name such as inset or extrude stands for every branch that starts with it: inset_region and inset_individual.
  const prefixed = branches ? [...branches].filter(([name]) => name.startsWith(`${branchName}_`)) : [];
  if (prefixed.length === 1) return outlineSchema(withDefinitions(prefixed[0][1]));
  if (prefixed.length > 1) return unionIndex(topic, new Map(prefixed), jsonSchema.$defs);
  // A dotted field of a plain topic, such as environment.spotLights, is that field's outline.
  const ownProperties = jsonSchema.properties ?? {};
  if (!branches && Object.hasOwn(ownProperties, branchName)) return outlineSchema(withDefinitions(ownProperties[branchName]));
  const known = branches ? [...branches.keys()] : Object.keys(ownProperties);
  const sharedField = branches && [...branches.values()].some(branch => Object.hasOwn(branch.properties ?? {}, branchName));
  const fieldNote = sharedField ? ` ${branchName} is a field of those branches, not a branch: open one branch to see it.` : '';
  if (MODIFIER_TOPICS.has(topic) && Object.hasOwn(MODIFIER_OPERATIONS, branchName)) {
    throw new TopicEntryError(`${branchName} is a modifier op that ${topic} accepts, so it has no branch here: read topic meshModifiers.${branchName} for its fields.`);
  }
  throw new TopicEntryError(`Topic ${topic} has no ${branches ? 'branch' : 'field'} ${branchName}. ${branches ? 'Branches' : 'Fields'}: ${known.join(', ') || 'none'}.${fieldNote}`);
}

/** A near miss of a topic name: a leading "scene." is dropped, and a name that contains or is contained by exactly one topic (uvs for meshUv) stands for it. */
function closestTopic(name, allNames) {
  if (allNames.includes(name)) return name;
  const stem = name.toLowerCase().replace(/s$/, '');
  const near = stem.length < 2 ? [] : allNames.filter(candidate => {
    const lowered = candidate.toLowerCase();
    return lowered.includes(stem) || (lowered.length > 2 && stem.includes(lowered));
  });
  return near.length === 1 ? near[0] : undefined;
}

// Words an agent reaches for that stand for a topic under another name.
const TOPIC_ALIASES = Object.freeze({ render: 'jobs', renders: 'jobs', renderjobs: 'jobs' });

function editDistance(first, second) {
  let previousRow = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let row = 1; row <= first.length; row++) {
    const currentRow = [row];
    for (let column = 1; column <= second.length; column++) {
      const substitution = previousRow[column - 1] + (first[row - 1] === second[column - 1] ? 0 : 1);
      currentRow.push(Math.min(previousRow[column] + 1, currentRow[column - 1] + 1, substitution));
    }
    previousRow = currentRow;
  }
  return previousRow[second.length];
}

/** The topics worth suggesting for an unknown name: an alias first, then names within two edits or sharing a stem. */
function suggestTopics(name, allNames) {
  const lowered = name.toLowerCase();
  const aliased = TOPIC_ALIASES[lowered];
  if (aliased && allNames.includes(aliased)) return [aliased];
  const stem = lowered.replace(/(ies|y|s)$/, '');
  return allNames.filter(candidate => {
    const candidateLowered = candidate.toLowerCase();
    return editDistance(lowered, candidateLowered) <= 2 || (stem.length >= 4 && candidateLowered.includes(stem));
  }).slice(0, 3);
}

/** The dotted topics (meshEdit.uv_unwrap) whose branch is the given name, for a bare op name or the wrong plural form. */
function branchTopicsNamed(branchName, outlineSources) {
  const found = [];
  for (const [topic, schema] of outlineSources) {
    const branches = unionBranches(inputJsonSchema(schema));
    if (branches?.has(branchName)) found.push(`${topic}.${branchName}`);
  }
  return found.slice(0, MAX_SUGGESTIONS);
}

/** The topics a caller can ask for, by name. */
export function capabilityTopicNames(capabilities, outlineSources) {
  const names = {
    scene: [...sceneTopics(capabilities.scene).keys()],
    runtime: RUNTIME_SECTIONS,
    schemas: [...outlineSources.keys()],
  };
  return names;
}

/** The most topics one scene_capabilities call may list. */
export const MAX_TOPICS_PER_CALL = 8;

/** The most unknown entries a partial list answer reports, and the most suggestions each one carries. */
const MAX_REPORTED_UNKNOWN = 4;
const MAX_SUGGESTIONS = 3;

/** Thrown when one entry of a topic request cannot be answered; the note says why and what it may have meant. */
class TopicEntryError extends Error {
  constructor(note, suffix = '') {
    super(`${note}${suffix}`);
    this.note = note;
  }
}

/** Thrown when a topic name matches nothing; the message also lists every topic. */
class UnknownTopicError extends TopicEntryError {
  constructor(note, allNames) {
    super(note, ` Topics: ${allNames.join(', ')}.`);
  }
}

const GROUP_NAMES = ['scene', 'runtime', 'schemas'];

function indexAnswer(capabilities, names) {
  return {
    format: capabilities.scene.format, schemaVersion: capabilities.scene.schemaVersion,
    phase: capabilities.phase, availableIn: capabilities.availableIn,
    how: `Call scene_capabilities with topic set to a name below, or to a list of up to ${MAX_TOPICS_PER_CALL} names to read several at once. Tools list common fields; each name in topics.schemas gives the full field list of a recipe part, and the group names scene, runtime and schemas list their topics (meshEdit and meshStack also take <name>.<op>, geometries takes geometries.<type>). examples.<tool> is one complete call.`,
    topics: names,
  };
}

function answerOneTopic(capabilities, topic, names, outlineSources) {
  const allNames = [...names.scene, ...names.runtime, ...names.schemas];
  // A group name is not a topic, but an agent that read the index asks for it: answer with the topics it holds.
  if (GROUP_NAMES.includes(topic) && !allNames.includes(topic)) {
    return { topic, value: { topics: names[topic], use: `${topic} is a group of topics; ask for one of its names, or ${topic}.<name>.` } };
  }
  const parts = topic.split('.');
  // The index groups topics under scene, runtime and schemas; a caller may repeat the group as a prefix (schemas.geometries).
  if (GROUP_NAMES.includes(parts[0]) && parts.length > 1) parts.shift();
  const [requestedName, branchName] = parts;
  const aliased = TOPIC_ALIASES[requestedName.toLowerCase()];
  const name = closestTopic(requestedName, allNames) ?? (allNames.includes(aliased) ? aliased : requestedName);
  const notes = sceneTopics(capabilities.scene).get(name);
  const runtime = RUNTIME_SECTIONS.includes(name) ? capabilities[name] : undefined;
  const source = outlineSources.get(name);
  const found = [notes, runtime, source].some(value => value !== undefined);
  if (!found) {
    const branchTopics = branchTopicsNamed(requestedName, outlineSources);
    // A bare geometry or op name (cylinder, uv_unwrap) that is the branch of exactly one topic means that topic (#3018).
    if (branchName === undefined && branchTopics.length === 1) {
      return answerOneTopic(capabilities, branchTopics[0], names, outlineSources);
    }
    const suggestions = [...new Set([...suggestTopics(requestedName, allNames), ...branchTopics])].slice(0, MAX_SUGGESTIONS);
    const didYouMean = suggestions.length ? ` Did you mean ${suggestions.join(' or ')}?` : '';
    throw new UnknownTopicError(`Unknown topic ${topic}.${didYouMean}`, allNames);
  }
  const answeredTopic = [name, branchName].filter(Boolean).join('.');
  if (source) return { topic: answeredTopic, ...(notes === undefined ? {} : { notes }), fields: outlineAnswer(name, branchName, source) };
  // A dotted name picks one entry of a plain topic: examples.scene_apply.
  const content = notes ?? runtime;
  if (branchName === undefined) return { topic: answeredTopic, value: content };
  const entries = content !== null && typeof content === 'object' ? content : {};
  if (!Object.hasOwn(entries, branchName)) {
    const opTopics = branchTopicsNamed(branchName, outlineSources);
    const opHint = opTopics.length ? ` ${branchName} is a branch: ask ${opTopics.join(' or ')}.` : '';
    throw new TopicEntryError(`Topic ${name} has no entry ${branchName}. Entries: ${Object.keys(entries).join(', ') || 'none'}.${opHint}`);
  }
  return { topic: answeredTopic, value: entries[branchName] };
}

function checkTopicList(topics) {
  if (topics.length === 0 || topics.length > MAX_TOPICS_PER_CALL) {
    throw new Error(`topic list has ${topics.length} entries; pass 1 to ${MAX_TOPICS_PER_CALL} names, or one string.`);
  }
  const repeated = topics.filter((topic, position) => topics.indexOf(topic) !== position);
  if (repeated.length) throw new Error(`topic list repeats ${[...new Set(repeated)].join(', ')}; name each topic once.`);
  const notStrings = topics.filter(topic => typeof topic !== 'string' || topic.length === 0 || topic.length > 64);
  if (notStrings.length) throw new Error('topic list entries must be strings of 1 to 64 characters.');
}

function answerTopicList(capabilities, topics, names, outlineSources) {
  checkTopicList(topics);
  const answers = {};
  const unanswered = [];
  for (const topic of topics) {
    try {
      answers[topic] = answerOneTopic(capabilities, topic, names, outlineSources);
    } catch (error) {
      if (!(error instanceof TopicEntryError)) throw error;
      unanswered.push(error.note);
    }
  }
  if (unanswered.length === 0) return { answers };
  // One bad name does not fail the call: the valid topics answer and the rest are listed beside them.
  if (Object.keys(answers).length > 0) {
    return { answers, unknown: unanswered.slice(0, MAX_REPORTED_UNKNOWN), ...(unanswered.length > MAX_REPORTED_UNKNOWN ? { moreUnknown: unanswered.length - MAX_REPORTED_UNKNOWN } : {}), use: 'Call scene_capabilities with no topic for the list of topic names.' };
  }
  const allNames = [...names.scene, ...names.runtime, ...names.schemas];
  throw new Error(`${unanswered.join(' ')} Topics: ${allNames.join(', ')}.`);
}

/** The index with no topic, the detail of one topic, or { answers } keyed by name for a list of topics. */
export function answerCapabilities(capabilities, topic, outlineSources) {
  const names = capabilityTopicNames(capabilities, outlineSources);
  if (topic === undefined) return indexAnswer(capabilities, names);
  if (Array.isArray(topic)) return answerTopicList(capabilities, topic, names, outlineSources);
  return answerOneTopic(capabilities, topic, names, outlineSources);
}
