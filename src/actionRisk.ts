/** Risk classifier for what the Agents assistant types into terminals.
 *
 *  Anything it flags needs the user's approval, even in Auto mode. It is
 *  deliberately conservative: a false positive costs one click, a false
 *  negative could cost a repo. Pure and dependency-free, so
 *  scripts/action-risk-test.mjs runs it directly under node. */

type Rule = [RegExp, string];

/** Start of a command word: line start, whitespace or a shell separator. */
const W = String.raw`(?:^|[\s;&|(\x60{])`;

const COMMAND_RULES: Rule[] = [
  [new RegExp(String.raw`${W}(rm|rmdir|rd|del|erase|ri|unlink|shred|remove-item|clear-recyclebin)(\.exe)?(\s|$)`, "i"), "Deletes files"],
  [/\b(format-volume|clear-disk|initialize-disk|diskpart|mkfs(\.\w+)?)\b|(^|\s)format(\.com)?\s+[a-z]:/i, "Formats a disk"],
  [/\bgit\b[^\n]*\bpush\b/i, "Pushes to a remote"],
  [/\bgit\b[^\n]*\breset\b/i, "Resets git state"],
  [/\bgit\b[^\n]*\bclean\b/i, "Deletes untracked files"],
  [/\bgit\b[^\n]*\b(branch|tag)\b[^\n]*\s(-d|-D|--delete|-f|--force)\b/, "Deletes a branch or tag"],
  [/\bgit\b[^\n]*\b(checkout|restore|switch)\b[^\n]*(\s--(\s|$)|\s\.(\s|$)|\s-f\b|--force|--discard-changes)/i, "Discards local changes"],
  [/\bgit\b[^\n]*\b(rebase|filter-branch|filter-repo|reflog|gc|prune|stash\s+(drop|clear)|update-ref|replace)\b/i, "Rewrites git history"],
  [/\bgit\b[^\n]*\b(commit|merge|cherry-pick|revert|am|apply)\b[^\n]*(--amend|--no-verify|-n\b)/i, "Commits bypassing checks"],
  [/\bgh\b[^\n]*\b(delete|merge|release|close|archive|transfer|secret)\b/i, "Changes things on GitHub"],
  [/\b(npm|pnpm|yarn|bun)\s+(i|in|ins|install|add|ci|un|uninstall|remove|rm|r|update|upgrade|up|link|publish|unpublish|deprecate|dlx|x|audit\s+fix)\b/i, "Installs or removes packages"],
  [/\b(npx|pnpx|bunx)\b/i, "Downloads and runs a package"],
  [/\b(pip3?|pipx|uv|poetry|conda|mamba|gem|cargo|go|dotnet|nuget|composer|choco|winget|scoop|apt(-get)?|dnf|yum|pacman|brew|snap|rustup)\b[^\n]*\b(install|uninstall|add|remove|upgrade|update|publish|get|sync)\b/i, "Installs or removes packages"],
  [/\b(install-module|install-package|uninstall-module|uninstall-package|update-module|add-appxpackage|remove-appxpackage|msiexec)\b/i, "Installs or removes software"],
  [/\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer|bitsadmin|certutil)\b/i, "Downloads from the internet"],
  [/\b(iex|invoke-expression|invoke-command|eval|exec)\b/i, "Runs code from a string"],
  [/\|\s*&?\s*(sh|bash|zsh|fish|pwsh|powershell|cmd|python3?|node|perl|ruby|iex|invoke-expression)\b/i, "Pipes into a shell"],
  [/\b(sudo|su|runas|gsudo|doas)\b|-verb\s+runas/i, "Runs elevated"],
  [/\b(shutdown|restart-computer|stop-computer|reboot|poweroff|halt|logoff|rundll32)\b/i, "Shuts down or restarts"],
  [/\b(reg(\.exe)?\s+(add|delete|import|load|unload|restore|copy)|regedit|set-itemproperty|new-itemproperty|remove-itemproperty|rename-itemproperty)\b|\bhk(lm|cu|cr|u|cc):/i, "Edits the registry"],
  [/\.env\b|\.ssh\b|id_rsa|id_ed25519|id_ecdsa|\.pem\b|\.pfx\b|\.p12\b|\.key\b|\.npmrc|\.pypirc|\.netrc|\.git-credentials|\.aws\b|\.kube\b|\.docker[\\/]config|credential|secret|passw|token|apikey|api[_-]key|cmdkey|vault|keychain|gpg\b|ssh-add|ssh-keygen/i, "Touches credentials or secrets"],
  [/;|&&|\|\||&/, "Chains several commands"],
  [/(^|[^|])\|(?!\|)/, "Pipes between commands"],
  [/\$\(|\x60|<\(/, "Runs a subcommand"],
  [/(^|[^0-9])>{1,2}\s*[^&\s]|\b(set-content|out-file|add-content|clear-content|tee(-object)?|truncate)\b/i, "Writes to a file"],
  [new RegExp(String.raw`${W}(mv|move|mi|move-item|ren|rename|rename-item|cp|copy|cpi|copy-item|xcopy|robocopy|rsync|dd)(\.exe)?(\s|$)`, "i"), "Moves or overwrites files"],
  [/\b(kill|taskkill|stop-process|pkill|killall|spps)\b/i, "Stops processes"],
  [/\b(sc(\.exe)?\s+(delete|stop|config|create)|stop-service|set-service|remove-service|new-service|net\s+(user|localgroup|stop|share)|icacls|takeown|chmod|chown|attrib|setx|bcdedit|cipher|schtasks|set-executionpolicy|netsh|new-netfirewallrule|set-mppreference|wsl\s+--(unregister|uninstall))\b/i, "Changes system settings or permissions"],
  [/\b(drop\s+(table|database|schema|index)|truncate\s+table|delete\s+from|alter\s+table)\b/i, "Destroys database data"],
  [/\bdocker\b[^\n]*\b(rm|rmi|prune|down|kill|stop)\b|\bkubectl\b[^\n]*\b(delete|apply|drain|scale)\b/i, "Removes containers or infrastructure"],
  [/\b(publish|deploy|terraform\s+(apply|destroy)|vercel|netlify|firebase\s+deploy|fly\s+deploy|wrangler)\b/i, "Publishes or deploys"],
  [/\b(ssh|scp|sftp|ftp|telnet|nc|ncat|netcat)\b/i, "Connects to another machine"],
];

/** Plain-language asks that would have an agent do one of the above. */
const PROMPT_RULES: Rule[] = [
  [/\bpush(es|ed|ing)?\b/i, "Asks the agent to push"],
  [/\b(delete|remove|rm|wipe|erase|purge|destroy|drop|truncate|nuke|clean\s*up|cleanup|get rid of)\b/i, "Asks the agent to delete something"],
  [/\b(reset|revert|discard|rebase|squash|amend|force|overwrite|rewrite history)\b|--hard/i, "Asks for an irreversible change"],
  [/\b(install|uninstall|upgrade|downgrade|add (a |the )?(package|dependency|dep|library|crate|module))\b/i, "Asks the agent to install or remove packages"],
  [/\b(deploy|publish|release|ship|merge)\b/i, "Asks the agent to publish or merge"],
  [/\b(sudo|admin(istrator)?|elevat\w*|registry|regedit|format|shutdown|restart the (computer|machine|pc)|reboot)\b/i, "Asks for system-level changes"],
  [/\b(curl|wget|download|fetch .* (script|installer))\b/i, "Asks the agent to download something"],
  [/\.env\b|\.ssh\b|ssh key|credential|secret|password|api[ _-]?key|token/i, "Mentions credentials or secrets"],
  [/skip[- ]?permissions|dangerously|yolo|bypass|auto[- ]?approve|don'?t ask|without asking|allow all/i, "Asks the agent to skip its own approvals"],
];

function reasons(text: string, rules: Rule[]): string[] {
  const out: string[] = [];
  for (const [re, why] of rules) if (re.test(text) && !out.includes(why)) out.push(why);
  return out;
}

/** Why a shell command needs approval; empty when it looks harmless. */
export function commandRisks(command: string): string[] {
  return reasons(command.trim(), COMMAND_RULES);
}

/** Why a prompt for an agent needs approval; empty when it looks harmless.
 *  Code spans in the prompt are also checked as commands. */
export function promptRisks(text: string): string[] {
  const out = reasons(text, PROMPT_RULES);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    for (const why of commandRisks(m[1])) if (!out.includes(why)) out.push(why);
  }
  return out;
}
