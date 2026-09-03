import io

f = (
    r"C:\Users\mas20\AppData\Local\Temp\aura-wt\platform\apps\web"
    r"\app\(owner)\owner\transcription\transcription-client.tsx"
)

with io.open(f, encoding="utf-8") as fh:
    s = fh.read()

before = s.count("\x00")
# A raw NUL byte inside a source file makes grep, `file` and most diff viewers
# treat the whole module as binary. The escape sequence compiles to exactly the
# same string and leaves the file readable as text.
s = s.replace("\x00", "\\u0000")

with io.open(f, "w", encoding="utf-8", newline="") as fh:
    fh.write(s)

with io.open(f, "rb") as fh:
    raw = fh.read()

print("raw NULs before:", before, "| after:", raw.count(b"\x00"))
print("escape present:", raw.count(b"\\u0000"))
