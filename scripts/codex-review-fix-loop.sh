#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
BASE_BRANCH="main"
MAX_ITERATIONS=20
SLEEP_SECONDS=0
YOLO_MODE=1
DRY_RUN=0
STATE_ROOT=".git/codex-review-fix-loop"

print_usage() {
  cat <<'USAGE'
Usage: codex-review-fix-loop.sh [options]

Run a strict review -> fix Ralph-style loop for the current branch.

Options:
  --base <branch>           Base branch for review diffs (default: main)
  --max-iterations <n>      Maximum review->fix iterations (default: 20)
  --sleep-seconds <n>       Delay between fix and next review (default: 0)
  --state-root <path>       Directory for review/fix logs (default: .git/codex-review-fix-loop)
  --yolo                    Use non-interactive, unsandboxed Codex execution (default)
  --no-yolo                 Do not pass the dangerous bypass flag
  --dry-run                 Print commands and exit without running Codex
  -h, --help                Show this help text
USAGE
}

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

is_non_negative_integer() {
  [[ "$1" =~ ^[0-9]+$ ]]
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

format_command() {
  local formatted=""
  local token=""
  for token in "$@"; do
    formatted+=$(printf '%q ' "$token")
  done
  printf '%s' "${formatted% }"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base)
        [[ $# -ge 2 ]] || die "Option --base requires a value."
        BASE_BRANCH="$2"
        shift 2
        ;;
      --max-iterations)
        [[ $# -ge 2 ]] || die "Option --max-iterations requires a value."
        is_positive_integer "$2" || die "Option --max-iterations must be a positive integer."
        MAX_ITERATIONS="$2"
        shift 2
        ;;
      --sleep-seconds)
        [[ $# -ge 2 ]] || die "Option --sleep-seconds requires a value."
        is_non_negative_integer "$2" || die "Option --sleep-seconds must be a non-negative integer."
        SLEEP_SECONDS="$2"
        shift 2
        ;;
      --state-root)
        [[ $# -ge 2 ]] || die "Option --state-root requires a value."
        STATE_ROOT="$2"
        shift 2
        ;;
      --yolo)
        YOLO_MODE=1
        shift
        ;;
      --no-yolo)
        YOLO_MODE=0
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        print_usage
        exit 0
        ;;
      --)
        shift
        continue
        ;;
      *)
        die "Unknown option: $1"
        ;;
    esac
  done
}

build_review_prompt() {
  local current_branch="$1"
  cat <<EOF
Review the current branch "${current_branch}" against base branch "${BASE_BRANCH}".
Focus on actionable issues only: bugs, regressions, correctness risks, and missing tests.
Return findings ordered by severity with concrete file references.
The final line of your response MUST be exactly one of:
<review_status>CLEAN</review_status>
<review_status>HAS_FINDINGS</review_status>
EOF
}

build_fix_prompt() {
  local current_branch="$1"
  local review_report_path="$2"
  local iteration="$3"
  cat <<EOF
You are in an automated review -> fix loop for branch "${current_branch}" vs "${BASE_BRANCH}".
Iteration: ${iteration}
Latest review report file: ${review_report_path}

Task:
1. Read the review report from disk.
2. Fix every actionable finding in this repository.
3. Keep changes tightly scoped and avoid unrelated refactors.
4. Run targeted verification commands for the touched code.

Response format:
- Short summary of fixes.
- Verification commands and outcomes.
- Final line exactly: <fix_status>APPLIED</fix_status>
EOF
}

run_command_logged() {
  local log_file="$1"
  shift
  local -a cmd=("$@")
  log "Running: $(format_command "${cmd[@]}")"
  if ! "${cmd[@]}" | tee "$log_file"; then
    die "Command failed. See log: ${log_file}"
  fi
}

require_tools() {
  command -v codex >/dev/null 2>&1 || die "codex CLI not found in PATH."
  command -v git >/dev/null 2>&1 || die "git not found in PATH."
}

require_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "This command must run inside a git repository."
}

ensure_exec_review_available() {
  codex exec review --help >/dev/null 2>&1 || die "codex exec review is not available in this Codex CLI build."
}

main() {
  parse_args "$@"
  require_tools
  require_git_repo
  ensure_exec_review_available

  local repo_root
  repo_root="$(git rev-parse --show-toplevel)"
  cd "$repo_root"

  local current_branch
  current_branch="$(git rev-parse --abbrev-ref HEAD)"

  local run_stamp
  run_stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  local run_dir="${STATE_ROOT%/}/${run_stamp}"
  mkdir -p "$run_dir"

  log "Repo root: ${repo_root}"
  log "Branch: ${current_branch}"
  log "Base branch: ${BASE_BRANCH}"
  log "Max iterations: ${MAX_ITERATIONS}"
  log "YOLO mode: ${YOLO_MODE}"
  log "Run artifacts: ${run_dir}"

  local review_prompt
  review_prompt="$(build_review_prompt "$current_branch")"

  local iteration=1
  while [[ $iteration -le $MAX_ITERATIONS ]]; do
    local iter_label
    iter_label="$(printf '%02d' "$iteration")"
    local review_message_file="${run_dir}/iter-${iter_label}.review.md"
    local review_log_file="${run_dir}/iter-${iter_label}.review.log"
    local fix_message_file="${run_dir}/iter-${iter_label}.fix.md"
    local fix_log_file="${run_dir}/iter-${iter_label}.fix.log"

    log "----- Iteration ${iteration}/${MAX_ITERATIONS}: REVIEW -----"
    local -a review_cmd=(
      codex
      exec
      review
      --base
      "$BASE_BRANCH"
      --output-last-message
      "$review_message_file"
    )
    if [[ $YOLO_MODE -eq 1 ]]; then
      review_cmd+=(--dangerously-bypass-approvals-and-sandbox)
    fi
    review_cmd+=("$review_prompt")

    if [[ $DRY_RUN -eq 1 ]]; then
      log "Dry run command (review): $(format_command "${review_cmd[@]}")"
      local fix_prompt_preview
      fix_prompt_preview="$(build_fix_prompt "$current_branch" "$review_message_file" "$iteration")"
      local -a fix_cmd_preview=(
        codex
        exec
        --output-last-message
        "$fix_message_file"
      )
      if [[ $YOLO_MODE -eq 1 ]]; then
        fix_cmd_preview+=(--dangerously-bypass-approvals-and-sandbox)
      fi
      fix_cmd_preview+=("$fix_prompt_preview")
      log "Dry run command (fix): $(format_command "${fix_cmd_preview[@]}")"
      log "Dry run complete. No Codex commands were executed."
      exit 0
    fi

    run_command_logged "$review_log_file" "${review_cmd[@]}"

    if grep -Fq '<review_status>CLEAN</review_status>' "$review_message_file"; then
      log "Review reported CLEAN on iteration ${iteration}. Loop complete."
      log "Review/fix logs: ${run_dir}"
      exit 0
    fi

    if ! grep -Fq '<review_status>HAS_FINDINGS</review_status>' "$review_message_file"; then
      die "Review output missing required status marker. Check: ${review_message_file}"
    fi

    log "----- Iteration ${iteration}/${MAX_ITERATIONS}: FIX -----"
    local fix_prompt
    fix_prompt="$(build_fix_prompt "$current_branch" "$review_message_file" "$iteration")"
    local -a fix_cmd=(
      codex
      exec
      --output-last-message
      "$fix_message_file"
    )
    if [[ $YOLO_MODE -eq 1 ]]; then
      fix_cmd+=(--dangerously-bypass-approvals-and-sandbox)
    fi
    fix_cmd+=("$fix_prompt")

    run_command_logged "$fix_log_file" "${fix_cmd[@]}"

    if ! grep -Fq '<fix_status>APPLIED</fix_status>' "$fix_message_file"; then
      die "Fix output missing required status marker. Check: ${fix_message_file}"
    fi

    if [[ $SLEEP_SECONDS -gt 0 ]]; then
      log "Sleeping ${SLEEP_SECONDS}s before next review..."
      sleep "$SLEEP_SECONDS"
    fi

    iteration=$((iteration + 1))
  done

  log "Reached max iterations (${MAX_ITERATIONS}) without a CLEAN review marker."
  log "Review/fix logs: ${run_dir}"
  exit 2
}

main "$@"
