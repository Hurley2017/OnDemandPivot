# Transfer bundles

One `.txt` that rebuilds the project. It is a Python program as well as a text
file, so it unpacks with nothing else travelling alongside it:

```
python OnDemandPivot-Update.txt [output-dir]
```

## Which one to use

| File | Size | Contains | Use |
|---|---|---|---|
| `OnDemandPivot-Update.txt` | ~0.4 MB | Everything **except** `static/vendor/` | Routine updates |
| `OnDemandPivot-Bundle.txt` | ~6.5 MB | Everything, including the vendored engine and font | First-time setup only |

The vendored Perspective engine and Inter font are ~4.5 MB, are binary, and do
not change between feature work — so they are left out of the update bundle to
keep it small enough to read straight from GitHub's file view. A machine that
has already had the full bundle has them.

## Rebuilding on the other machine

```
python OnDemandPivot-Update.txt "C:\path\to\OnDemandPivot"
```

Point it at the existing project folder to overlay an update, or at a new folder
to lay down a fresh copy. Every file is checked against the byte count recorded
in its own header, and the run stops with a clear message if one does not match.

Then:

```
pip install -r requirements.txt
python app.py
```

The app never reaches the network once installed — it serves every asset from
disk. `pip install` is the only step that needs a connection, and only once.

## Regenerating

```
python make_bundle.py                                    # full, to the Desktop
python make_bundle.py --source-only bundle/OnDemandPivot-Update.txt
```

Both exclude anything git does not track, so test fixtures and local sample data
never travel.
