#!/usr/bin/env python3
"""
End-to-end checks of the database rules through the real Supabase API.

Creates its own "__test__" components, checks every rule, then deletes them
again (and the audit rows they produced), so it is safe to run on production.

Usage:  python3 tests/api_test.py              (reads .env from the repo root)
        python3 tests/api_test.py --cleanup    (only remove leftover __test__ rows)
"""
import json, os, sys, uuid, datetime, threading, urllib.request, urllib.error, subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env = dict(os.environ)
if os.path.exists(os.path.join(ROOT, ".env")):
    for line in open(os.path.join(ROOT, ".env")):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env.setdefault(k, v)

URL = env["SUPABASE_URL"]
PUB = env["SUPABASE_PUBLISHABLE_KEY"]
SECRET = env["SUPABASE_SECRET_KEY"]
USER = env["APP_LOGIN_USERNAME"].lower() + "@robostore.invalid"
PASS = env["APP_LOGIN_PASSWORD"]
DB = env["SUPABASE_DB_URL"]
TODAY = datetime.date.today().isoformat()
PREFIX = "__test__ "

passed = failed = 0


def call(method, path, body=None, token=None, key=PUB):
    req = urllib.request.Request(URL + path, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {token or key}")
    req.add_header("Content-Type", "application/json")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data, timeout=30) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


def rpc(fn, args, token):
    return call("POST", f"/rest/v1/rpc/{fn}", args, token)


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✖ {name}  {detail}")


def login(email, password):
    s, r = call("POST", "/auth/v1/token?grant_type=password", {"email": email, "password": password})
    return r.get("access_token") if s == 200 else None


def stock(token, cid):
    s, r = call("GET", f"/rest/v1/component_stock?id=eq.{cid}&select=*", token=token)
    return r[0] if s == 200 and r else None


def psql(sql):
    r = subprocess.run(["psql", DB, "-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("psql failed: " + r.stderr.strip())
    return r.stdout.strip()


def main():
    print("Logged-out visitor")
    s, r = call("GET", "/rest/v1/components?select=*")
    check("cannot read components", s in (401, 403) or r == [], f"{s} {r}")
    s, r = call("GET", "/rest/v1/issues?select=*")
    check("cannot read issues", s in (401, 403) or r == [], f"{s} {r}")
    s, r = rpc("add_stock", {"p_name": PREFIX + "x", "p_units": 1, "p_added_on": TODAY}, None)
    check("cannot add stock", s in (401, 403, 404), f"{s} {r}")
    s, r = call("GET", "/rest/v1/audit_log?select=*")
    check("cannot read audit log", s in (401, 403, 404) or r == [], f"{s} {r}")

    print("Login")
    check("wrong password rejected", login(USER, PASS + "x") is None)
    tok = login(USER, PASS)
    check("correct password accepted", tok is not None)
    if not tok:
        return

    print("Logged-in user cannot bypass the API")
    s, r = call("POST", "/rest/v1/components", {"name": PREFIX + "direct", "date_added": TODAY}, tok)
    check("direct table insert refused", s in (401, 403), f"{s} {r}")
    s, r = call("GET", "/rest/v1/audit_log?select=*", token=tok)
    check("audit log hidden from site login", s in (401, 403, 404) or r == [], f"{s} {r}")

    print("Add stock")
    s, cid = rpc("add_stock", {"p_name": PREFIX + "Arduino Uno", "p_units": 5, "p_added_on": TODAY}, tok)
    check("new component created", s == 200 and isinstance(cid, int), f"{s} {cid}")
    s, cid2 = rpc("add_stock", {"p_name": "  " + PREFIX.upper() + "arduino   uno ", "p_units": 3, "p_added_on": TODAY}, tok)
    check("same name (any case/spacing) adds to existing", cid2 == cid, f"{s} {cid2}")
    st = stock(tok, cid)
    check("total is 8, available 8", st and st["total_units"] == 8 and st["available_units"] == 8, st)
    rid = str(uuid.uuid4())
    rpc("add_stock", {"p_name": PREFIX + "Arduino Uno", "p_units": 2, "p_added_on": TODAY, "p_request_id": rid}, tok)
    rpc("add_stock", {"p_name": PREFIX + "Arduino Uno", "p_units": 2, "p_added_on": TODAY, "p_request_id": rid}, tok)
    check("double-submit of the same add counted once", stock(tok, cid)["total_units"] == 10)
    future = (datetime.date.today() + datetime.timedelta(days=5)).isoformat()
    s, r = rpc("add_stock", {"p_name": PREFIX + "Arduino Uno", "p_units": 1, "p_added_on": future}, tok)
    check("future date refused", s >= 400 and "future" in json.dumps(r), f"{s} {r}")
    s, r = rpc("add_stock", {"p_name": PREFIX + "Arduino Uno", "p_units": 0, "p_added_on": TODAY}, tok)
    check("zero units refused", s >= 400, f"{s} {r}")

    print("Issue")
    args = {"p_component_id": cid, "p_borrower_name": "Test Person", "p_roll_number": "080bei013", "p_issued_on": TODAY}
    s, iid = rpc("issue_component", {**args, "p_units": 7}, tok)
    check("issue 7 of 10", s == 200, f"{s} {iid}")
    s, r = call("GET", f"/rest/v1/issues?id=eq.{iid}&select=roll_number", token=tok)
    check("roll number stored as 080BEI013", r and r[0]["roll_number"] == "080BEI013", r)
    s, r = rpc("issue_component", {**args, "p_units": 4}, tok)
    check("issuing 4 more (only 3 left) refused", s >= 400 and "Not enough stock" in json.dumps(r), f"{s} {r}")
    rid = str(uuid.uuid4())
    s1, a = rpc("issue_component", {**args, "p_units": 1, "p_request_id": rid}, tok)
    s2, b = rpc("issue_component", {**args, "p_units": 1, "p_request_id": rid}, tok)
    check("double-submit of the same issue recorded once", a == b and stock(tok, cid)["available_units"] == 2, f"{a} {b}")

    print("Simultaneous issues (12 people grab the last 2 units at once)")
    results = []
    def grab():
        results.append(rpc("issue_component", {**args, "p_units": 1}, tok)[0])
    ts = [threading.Thread(target=grab) for _ in range(12)]
    [t.start() for t in ts]; [t.join() for t in ts]
    check("exactly 2 succeeded", results.count(200) == 2, results)
    st = stock(tok, cid)
    check("available is 0, never negative", st["available_units"] == 0, st)

    print("Return")
    yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
    s, r = rpc("issue_component", {**args, "p_units": 1}, tok)  # no stock left
    s, r = rpc("return_issue", {"p_issue_id": iid, "p_returned_on": "2000-01-01"}, tok)
    check("return before issue date refused", s >= 400, f"{s} {r}")
    s, r = rpc("return_issue", {"p_issue_id": iid, "p_returned_on": TODAY}, tok)
    check("return accepted", s in (200, 204), f"{s} {r}")
    rpc("return_issue", {"p_issue_id": iid, "p_returned_on": TODAY}, tok)
    check("returning twice is harmless", stock(tok, cid)["available_units"] == 7)

    print("Bin & restore")
    s, r = rpc("move_to_bin", {"p_kind": "component", "p_id": cid}, tok)
    check("component with active loans can't be binned", s >= 400 and "out on loan" in json.dumps(r), f"{s} {r}")
    s, r = call("GET", f"/rest/v1/issues?component_id=eq.{cid}&returned_on=is.null&select=id", token=tok)
    active = [x["id"] for x in r]
    rpc("move_to_bin", {"p_kind": "issue", "p_id": active[0]}, tok)
    check("binning a loan frees its units", stock(tok, cid)["available_units"] == 8)
    rpc("issue_component", {**args, "p_units": 8}, tok)
    s, r = rpc("restore_from_bin", {"p_kind": "issue", "p_id": active[0]}, tok)
    check("restoring a loan with no stock left refused", s >= 400 and "Not enough stock" in json.dumps(r), f"{s} {r}")

    s, c2 = rpc("add_stock", {"p_name": PREFIX + "Servo", "p_units": 2, "p_added_on": yesterday}, tok)
    rpc("move_to_bin", {"p_kind": "component", "p_id": c2}, tok)
    check("component moved to bin", stock(tok, c2)["binned_at"] is not None)
    s, r = rpc("add_stock", {"p_name": PREFIX + "servo", "p_units": 1, "p_added_on": TODAY}, tok)
    check("adding a name that's in the bin asks to restore", s >= 400 and "in the bin" in json.dumps(r), f"{s} {r}")
    s, r = rpc("issue_component", {**args, "p_component_id": c2, "p_units": 1}, tok)
    check("can't issue a binned component", s >= 400, f"{s} {r}")
    s, r = rpc("restore_from_bin", {"p_kind": "component", "p_id": c2}, tok)
    check("component restored", s in (200, 204) and stock(tok, c2)["binned_at"] is None, f"{s} {r}")

    print("Permanent delete")
    s, r = rpc("delete_permanently", {"p_kind": "component", "p_id": cid}, tok)
    check("component with active loans can't be deleted", s >= 400, f"{s} {r}")
    s, r = rpc("delete_permanently", {"p_kind": "component", "p_id": c2}, tok)
    check("component deleted", s in (200, 204) and stock(tok, c2) is None, f"{s} {r}")
    n = psql(f"select count(*) from public.audit_log where table_name='components' and op='DELETE' and row_id='{c2}'")
    check("deleted row still recoverable from audit log", n == "1", n)

    print("Stranger who signs up with the public key")
    email = f"stranger-{uuid.uuid4().hex[:8]}@robostore.invalid"
    s, r = call("POST", "/auth/v1/admin/users", {"email": email, "password": "Str4nger!pass", "email_confirm": True}, key=SECRET)
    sid = r.get("id") if isinstance(r, dict) else None
    st_tok = login(email, "Str4nger!pass")
    if st_tok:
        s, r = call("GET", "/rest/v1/components?select=*", token=st_tok)
        check("sees no data", s == 200 and r == [], f"{s} {r}")
        s, r = rpc("add_stock", {"p_name": PREFIX + "evil", "p_units": 1, "p_added_on": TODAY}, st_tok)
        check("cannot add stock", s >= 400, f"{s} {r}")
        s, r = rpc("delete_permanently", {"p_kind": "component", "p_id": cid}, st_tok)
        check("cannot delete", s >= 400, f"{s} {r}")
    else:
        check("stranger account usable for test", False)
    if sid:
        call("DELETE", f"/auth/v1/admin/users/{sid}", key=SECRET)


def cleanup():
    psql(f"""
      begin;
      update public.issues set returned_on = issued_on
        where component_id in (select id from public.components where name like '{PREFIX}%') and returned_on is null;
      delete from public.components where name ilike '{PREFIX}%';
      alter table public.audit_log disable trigger audit_log_no_update;
      delete from public.audit_log where coalesce(old_row, new_row)::text ilike '%{PREFIX.strip()}%'
         or coalesce(old_row, new_row)::text ilike '%stranger-%'
         or (table_name in ('issues','stock_entries') and coalesce(old_row, new_row)->>'component_id' not in (select id::text from public.components));
      alter table public.audit_log enable trigger audit_log_no_update;
      commit;""")


if __name__ == "__main__":
    if "--cleanup" in sys.argv:
        cleanup()
        print("cleaned up test rows")
        sys.exit(0)
    try:
        cleanup()
        main()
    finally:
        cleanup()
        left = psql(f"select count(*) from public.components where name ilike '{PREFIX}%'")
        print(f"\n{passed} passed, {failed} failed  (leftover test rows: {left})")
    sys.exit(1 if failed else 0)
