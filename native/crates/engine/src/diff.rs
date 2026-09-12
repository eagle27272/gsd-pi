//! Unified diff generation for the edit tool.
//!
//! - `generateDiff`: unified diff with line numbers and context, matching the JS output format
//!
//! Fuzzy matching deliberately has no native counterpart. It is not a
//! standalone substring search: applying a fuzzy match safely requires a map
//! from each normalized code unit back to the source range that produced it,
//! so the matched region can be spliced into the *original* text. See
//! `buildFuzzySourceMap` in `packages/pi-coding-agent/src/core/tools/edit-diff.ts`
//! and issue #4.

use napi_derive::napi;

// ---------------------------------------------------------------------------
// generateDiff
// ---------------------------------------------------------------------------

#[napi(object)]
pub struct DiffResult {
    pub diff: String,
    pub first_changed_line: Option<i32>,
}

/// Generate a unified diff string with line numbers and context.
///
/// Uses the `similar` crate (Myers' diff algorithm with optimizations).
/// Output format matches the JS `generateDiffString`:
/// - `+N line` for additions
/// - `-N line` for removals
/// - ` N line` for context
/// - ` ... ` for skipped context
#[napi(js_name = "generateDiff")]
pub fn generate_diff(old_content: String, new_content: String, context_lines: Option<u32>) -> DiffResult {
    let context = context_lines.unwrap_or(4) as usize;
    generate_diff_impl(&old_content, &new_content, context)
}

fn generate_diff_impl(old_content: &str, new_content: &str, context_lines: usize) -> DiffResult {
    let old_lines: Vec<&str> = old_content.split('\n').collect();
    let new_lines: Vec<&str> = new_content.split('\n').collect();

    let max_line_num = old_lines.len().max(new_lines.len());
    let line_num_width = if max_line_num == 0 {
        1
    } else {
        max_line_num.to_string().len()
    };

    // Use similar crate for diffing
    let diff = similar::TextDiff::configure()
        .algorithm(similar::Algorithm::Myers)
        .diff_lines(old_content, new_content);

    let mut output: Vec<String> = Vec::new();
    let mut old_line_num: usize = 1;
    let mut new_line_num: usize = 1;
    let mut last_was_change = false;
    let mut first_changed_line: Option<i32> = None;

    // Build parts from diff ops, matching the JS `diff` npm package structure
    #[derive(Debug)]
    enum PartTag {
        Equal,
        Added,
        Removed,
    }

    struct Part {
        tag: PartTag,
        lines: Vec<String>,
    }

    let mut parts: Vec<Part> = Vec::new();

    for op in diff.ops() {
        match op {
            similar::DiffOp::Equal { old_index, len, .. } => {
                let lines: Vec<String> = old_lines[*old_index..*old_index + *len]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                parts.push(Part { tag: PartTag::Equal, lines });
            }
            similar::DiffOp::Delete { old_index, old_len, .. } => {
                let lines: Vec<String> = old_lines[*old_index..*old_index + *old_len]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                parts.push(Part { tag: PartTag::Removed, lines });
            }
            similar::DiffOp::Insert { new_index, new_len, .. } => {
                let lines: Vec<String> = new_lines[*new_index..*new_index + *new_len]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                parts.push(Part { tag: PartTag::Added, lines });
            }
            similar::DiffOp::Replace {
                old_index, old_len, new_index, new_len, ..
            } => {
                let del_lines: Vec<String> = old_lines[*old_index..*old_index + *old_len]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                parts.push(Part { tag: PartTag::Removed, lines: del_lines });

                let ins_lines: Vec<String> = new_lines[*new_index..*new_index + *new_len]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                parts.push(Part { tag: PartTag::Added, lines: ins_lines });
            }
        }
    }

    for (i, part) in parts.iter().enumerate() {
        let raw = &part.lines;

        match part.tag {
            PartTag::Added | PartTag::Removed => {
                if first_changed_line.is_none() {
                    first_changed_line = Some(new_line_num as i32);
                }

                for line in raw {
                    match part.tag {
                        PartTag::Added => {
                            let num = format!("{:>width$}", new_line_num, width = line_num_width);
                            output.push(format!("+{} {}", num, line));
                            new_line_num += 1;
                        }
                        PartTag::Removed => {
                            let num = format!("{:>width$}", old_line_num, width = line_num_width);
                            output.push(format!("-{} {}", num, line));
                            old_line_num += 1;
                        }
                        _ => unreachable!(),
                    }
                }
                last_was_change = true;
            }
            PartTag::Equal => {
                let next_part_is_change = i < parts.len() - 1
                    && matches!(parts[i + 1].tag, PartTag::Added | PartTag::Removed);

                if last_was_change || next_part_is_change {
                    let mut lines_to_show = raw.as_slice();
                    let mut skip_start = 0usize;
                    let mut skip_end = 0usize;

                    if !last_was_change {
                        // Show only last N lines as leading context
                        skip_start = raw.len().saturating_sub(context_lines);
                        lines_to_show = &raw[skip_start..];
                    }

                    if !next_part_is_change && lines_to_show.len() > context_lines {
                        // Show only first N lines as trailing context
                        skip_end = lines_to_show.len() - context_lines;
                        lines_to_show = &lines_to_show[..context_lines];
                    }

                    if skip_start > 0 {
                        output.push(format!(
                            " {:>width$} ...",
                            "",
                            width = line_num_width
                        ));
                        old_line_num += skip_start;
                        new_line_num += skip_start;
                    }

                    for line in lines_to_show {
                        let num = format!("{:>width$}", old_line_num, width = line_num_width);
                        output.push(format!(" {} {}", num, line));
                        old_line_num += 1;
                        new_line_num += 1;
                    }

                    if skip_end > 0 {
                        output.push(format!(
                            " {:>width$} ...",
                            "",
                            width = line_num_width
                        ));
                        old_line_num += skip_end;
                        new_line_num += skip_end;
                    }
                } else {
                    old_line_num += raw.len();
                    new_line_num += raw.len();
                }

                last_was_change = false;
            }
        }
    }

    DiffResult {
        diff: output.join("\n"),
        first_changed_line,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_diff_basic() {
        let old = "line1\nline2\nline3";
        let new_text = "line1\nmodified\nline3";
        let result = generate_diff_impl(old, new_text, 4);
        assert!(result.diff.contains("-"));
        assert!(result.diff.contains("+"));
        assert!(result.diff.contains("line2"));
        assert!(result.diff.contains("modified"));
        assert!(result.first_changed_line.is_some());
    }

    #[test]
    fn test_generate_diff_addition() {
        let old = "line1\nline3";
        let new_text = "line1\nline2\nline3";
        let result = generate_diff_impl(old, new_text, 4);
        assert!(result.diff.contains("+"));
        assert!(result.diff.contains("line2"));
    }

    #[test]
    fn test_generate_diff_deletion() {
        let old = "line1\nline2\nline3";
        let new_text = "line1\nline3";
        let result = generate_diff_impl(old, new_text, 4);
        assert!(result.diff.contains("-"));
        assert!(result.diff.contains("line2"));
    }

    #[test]
    fn test_generate_diff_context_ellipsis() {
        let mut old_lines: Vec<String> = (1..=20).map(|i| format!("line{}", i)).collect();
        let old = old_lines.join("\n");
        old_lines[10] = "modified".to_string();
        let new_text = old_lines.join("\n");
        let result = generate_diff_impl(&old, &new_text, 2);
        assert!(result.diff.contains("..."));
    }

    #[test]
    fn test_generate_diff_empty() {
        let result = generate_diff_impl("same", "same", 4);
        assert!(result.diff.is_empty());
        assert!(result.first_changed_line.is_none());
    }
}
