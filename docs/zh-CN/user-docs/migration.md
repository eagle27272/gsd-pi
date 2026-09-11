# 从 v1 迁移

如果你有仍在使用 Git Ship Done v1（现由社区以 [gsd-core](https://github.com/open-gsd/gsd-core) 继续维护）`.planning` 目录结构的项目，可以把它们迁移到 gsd-pi 的 `.gsd` 格式。

## 迁移后

迁移完成后，用下面的命令检查输出结果：

```bash
/gsd doctor
```

它会检查 `.gsd/` 的完整性，并标出任何结构性问题。
