"""`_changed_files` parses three git commands out of ONE shell round trip.

Collapsing five round trips into one took the panel from 4.8s to 1.0s, and the cost was
a hand-written parser over marker-delimited output. These pin its edges, which is where
a parser like this goes wrong.
"""

from routes.sandbox_files import WORKDIR, _changed_files

from .conftest import FakeBackend


def run(output: str) -> list[dict]:
    return _changed_files(FakeBackend(output))


def test_parses_all_three_sections():
    entries = run(
        "<<<modified>>>\n"
        "3\t1\tsrc/router.js\n"
        "<<<deleted>>>\n"
        "<<<added>>>\n"
        "7\tsrc/version.js\n"
    )
    assert entries == [
        {
            "path": f"{WORKDIR}/src/router.js",
            "additions": 3,
            "deletions": 1,
            "status": "modified",
        },
        {
            "path": f"{WORKDIR}/src/version.js",
            "additions": 7,
            "deletions": 0,
            "status": "added",
        },
    ]


def test_empty_workspace_yields_nothing():
    assert run("<<<modified>>>\n<<<deleted>>>\n<<<added>>>\n") == []


def test_binary_files_count_as_zero():
    """git's numstat writes `-` for a binary file instead of a count."""
    entries = run("<<<modified>>>\n-\t-\tassets/logo.png\n<<<deleted>>>\n<<<added>>>\n")
    assert entries[0]["additions"] == 0
    assert entries[0]["deletions"] == 0
    assert entries[0]["status"] == "modified"


def test_results_are_sorted_by_path():
    entries = run(
        "<<<modified>>>\n"
        "1\t0\tz.js\n"
        "1\t0\ta.js\n"
        "1\t0\tm.js\n"
        "<<<deleted>>>\n<<<added>>>\n"
    )
    assert [e["path"] for e in entries] == [
        f"{WORKDIR}/a.js",
        f"{WORKDIR}/m.js",
        f"{WORKDIR}/z.js",
    ]


def test_deleted_marks_a_file_already_seen_as_modified():
    entries = run(
        "<<<modified>>>\n0\t4\tgone.js\n<<<deleted>>>\ngone.js\n<<<added>>>\n"
    )
    assert entries[0]["status"] == "deleted"
    assert entries[0]["deletions"] == 4


def test_deleted_alone_produces_no_entry():
    """A deleted path absent from numstat is dropped.

    Documented behaviour rather than an aspiration: the deleted pass only *upgrades* an
    existing entry. Pinned so a future change to the shell script notices.
    """
    assert run("<<<modified>>>\n<<<deleted>>>\nghost.js\n<<<added>>>\n") == []


def test_added_overwrites_modified_for_the_same_path():
    """Entries are keyed by path, and the added pass runs last."""
    entries = run(
        "<<<modified>>>\n9\t9\tsame.js\n<<<deleted>>>\n<<<added>>>\n2\tsame.js\n"
    )
    assert len(entries) == 1
    assert entries[0]["status"] == "added"
    assert entries[0]["additions"] == 2
    assert entries[0]["deletions"] == 0


def test_malformed_lines_are_skipped_not_fatal():
    """Shell output is not a contract. A bad line must not take the panel down."""
    entries = run(
        "<<<modified>>>\n"
        "garbage with no tabs\n"
        "1\t2\n"                    # too few fields
        "1\t2\tok.js\n"
        "<<<deleted>>>\n"
        "<<<added>>>\n"
        "no-tab-here\n"             # no tab -> no rel -> skipped
    )
    assert [e["path"] for e in entries] == [f"{WORKDIR}/ok.js"]


def test_output_before_the_first_marker_is_ignored():
    """`git init` noise can precede the markers on a fresh workspace."""
    entries = run(
        "Initialized empty Git repository\n"
        "<<<modified>>>\n1\t0\treal.js\n<<<deleted>>>\n<<<added>>>\n"
    )
    assert [e["path"] for e in entries] == [f"{WORKDIR}/real.js"]


def test_runs_exactly_one_shell_command():
    """The whole point of the function. Each execute is ~1s against a real machine."""
    backend = FakeBackend("<<<modified>>>\n<<<deleted>>>\n<<<added>>>\n")
    _changed_files(backend)
    assert len(backend.commands) == 1
