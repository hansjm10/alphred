export const EXIT_SUCCESS = 0;
export const EXIT_USAGE_ERROR = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_RUNTIME_ERROR = 4;

export const RUN_USAGE =
  'Usage: alphred run --tree <tree_key> [--repo <name|github:owner/repo|azure:org/project/repo>] [--branch <branch_name>] [--execution-scope <full|single_node>] [--node-selector <next_runnable|node_key>] [--node-key <node_key>]';
export const STATUS_USAGE = 'Usage: alphred status --run <run_id>';
export const LIST_USAGE = 'Usage: alphred list';
export const REPO_USAGE = 'Usage: alphred repo <add|list|show|remove|sync>';
export const REPO_ADD_USAGE = 'Usage: alphred repo add --name <name> (--github <owner/repo> | --azure <org/project/repo>)';
export const REPO_LIST_USAGE = 'Usage: alphred repo list';
export const REPO_SHOW_USAGE = 'Usage: alphred repo show <name>';
export const REPO_REMOVE_USAGE = 'Usage: alphred repo remove <name> [--purge]';
export const REPO_SYNC_USAGE = 'Usage: alphred repo sync <name> [--strategy <ff-only|merge|rebase>]';
