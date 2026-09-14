# Claude skills

Also on the site: [flyaiworld.com/agents](https://flyaiworld.com/agents).

## fly-mode 🪰

Makes Claude act like a fruit fly, with every reaction coming from a real fly brain: your message becomes something
a fly can sense (a looming shape, a taste, a fly walking past, wind, a touch, a smell), that sense is stimulated in
the MaleCNS v1.0 connectome (166,700 neurons, [`flybrain`](https://pypi.org/project/flybrain/)), and what its neurons
make it do (jump, buzz, groom, turn...) decides how Claude replies. Every reply ends with a brain log.

Install for Claude Code:

```bash
pip install flybrain
cp -r skills/fly-mode ~/.claude/skills/          # all projects
# or: cp -r skills/fly-mode .claude/skills/       # this project only
```

Then say "be a fly". Say "human mode" to stop.

Try the brain on its own:

```bash
python skills/fly-mode/scripts/fly_brain.py "someone brought pizza"
```

The keyword table that turns words into senses is hand-written and is the only made-up part; the reaction is the
connectome's. The first run downloads ~260 MB of brain files.
