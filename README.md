# ICSOC original dataset

This orphan branch of [isa-group/OpenBinding](https://github.com/isa-group/OpenBinding)
holds only the source dataset of the ICSOC placement experiment
(*QoS-aware Placement of FaaS Compositions in the Cloud-Edge Continuum*):

```text
experimentation/icsoc/original_dataset/
├── applications.json      # FaaS applications and orchestration structures
└── infrastructures/       # generated infrastructures per dataset seed and size
```

## Origin

The tree `experimentation/icsoc/original_dataset/` is byte-for-byte identical
to the same path in commit `014e43a` ("feat(qacobench): release 1.1.1 with
verified reference campaign") of the `feat-isa` branch (tree object
`0736cb13e5d0d8424af4292587fd256964c039cb`, 1,401 files, about 980 MiB). It was
moved here so that development branches stay small; the code that consumes it
(`experimentation/icsoc/generator/`, `campaign.py`, the notebooks and the
regression tests) remains on the development branches.

## Usage

From a checkout of a development branch, at the repository root:

```bash
git fetch origin data/icsoc-original-dataset

# Extract the files in place (the path is git-ignored on development branches)
git archive FETCH_HEAD experimentation/icsoc/original_dataset | tar -x

# Or keep a separate worktree and pass --dataset to the generator
git worktree add --detach ../openbinding-icsoc-data FETCH_HEAD
```

Then follow `experimentation/icsoc/README.md` on the development branch.
