// The startup flags of crucible-mcp, in one place so --help and the parse error list the same ones.
export const MCP_OPTION_FLAGS = Object.freeze([
  { name: '--addons', value: '<absolute folder with node_modules>', note: 'with one --allow-addon <package name> for each allowed addon' },
  { name: '--allow-addon', value: '<package name>', note: 'repeatable, chosen only here' },
  { name: '--backend', value: 'cpu|gpu', note: 'default gpu' },
  { name: '--browser', value: '<local Chrome/Chromium executable path>', note: 'default is the installed Chrome' },
  { name: '--memory', value: '<32..4096 MiB>', note: 'default 192; the top is half of the machine RAM, at most 4096, and it also raises the Node RSS and heap guard of a job' },
  { name: '--assets', value: '<absolute GLB directory>' },
  { name: '--max-asset-bytes', value: '<1048576..268435456>', note: 'default 67108864 (64 MiB) for one GLB and for the assets of one call; raise it on a machine you control for large scans, a local Chrome test lost the preview page from 80 MiB' },
  { name: '--packs', value: '<absolute folder of data-only packs, or none>', note: 'default ~/.crucible/packs (or CRUCIBLE_PACKS_HOME) when it exists, where crucible packs add installs' },
  { name: '--jobs', value: '<absolute private output directory>', note: 'required for render jobs' },
  { name: '--gpu-queue', value: '<absolute executable, or JSON array ["bash","/path/queue.sh"]>', note: 'optional: a command that runs the program it is given once the GPU has room; looks, reviews, bakes and render jobs wait for it' },
  { name: '--gpu-queue-wait', value: '<1..3600 seconds>', note: 'longest wait for the queue to grant the GPU, default 600' },
  { name: '--ffmpeg', value: '<absolute executable>', note: 'default is ffmpeg on PATH' },
  { name: '--audio', value: '<absolute folder of .wav, .mp3, .ogg or .flac files for video jobs>' },
  { name: '--branches', value: 'on|off', note: 'default on' },
  { name: '--relations', value: 'on|off', note: 'default on' },
  { name: '--findings', value: 'on|off', note: 'default on; off hides the findings in scene_look for benchmark controls' },
  { name: '--schema-compat', value: 'auto|off|gemini|openai-strict', note: 'default auto; normalizes tools/list schemas for stricter MCP clients' },
  { name: '--tools', value: '<comma-separated tool names>', note: 'default every tool; list only these, scene_capabilities required, to send fewer schemas each turn' },
]);

export const MCP_OPTION_NAMES = Object.freeze(MCP_OPTION_FLAGS.map(flag => flag.name));

export function mcpOptionSummary() {
  return MCP_OPTION_FLAGS.map(flag => `${flag.name} ${flag.value}${flag.note ? ` (${flag.note})` : ''}`).join(', ');
}

export function mcpHelpText(version, { noPromo = process.env.CRUCIBLE_NO_PROMO === '1' } = {}) {
  const lines = MCP_OPTION_FLAGS.map(flag => `  ${flag.name} ${flag.value}${flag.note ? `  -- ${flag.note}` : ''}`);
  const promoNote = noPromo ? '' : ' (250 free credits, no card needed)';
  return `crucible-mcp ${version}
Usage: crucible-mcp [options]
       crucible-mcp --version | --check-update | --help

Options:
${lines.join('\n')}

Connect an MCP client over stdin/stdout. Chrome starts on the first scene.
Render jobs require --jobs; MP4 encoding uses FFmpeg on PATH unless --ffmpeg is supplied.
Documentation: https://crucible.codepawl.com/mcp.md

Built-in headless AI:
  Run \`crucible auth login\`${promoNote} to sign in.
  Run \`crucible agent "<prompt>"\` to build or edit scenes from the terminal.`;
}
