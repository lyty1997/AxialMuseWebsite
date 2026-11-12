"""按现有未签名 DNS 基线检查递归、权威与父区；不写 DNS、不输出地址。"""

import re
import subprocess

if __package__:
    from ops.monitor.bounded_process import ProcessOutputLimit, run_process
    from ops.monitor.public_health import HOSTS, HealthError, address_digest, require
else:
    from bounded_process import ProcessOutputLimit, run_process
    from public_health import HOSTS, HealthError, address_digest, require


ZONE = "axialmuse.com."
PARENT = "com."
NAMESERVERS = {"broderick.dnspod.net.", "sandpaper.dnspod.net."}
TYPES = {"A", "AAAA", "CNAME", "NS", "DS", "DNSKEY"}
NAME = re.compile(r"(?=.{1,254}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+", re.I)


def parse_response(text, name, record_type):
    """只接受一次完整的 dig 应答；空记录须由调用者核验否定应答来源。"""
    require(len(text) <= 65536, "DNS_RESPONSE_SIZE")
    headers = re.findall(r"^;; ->>HEADER<<- opcode: QUERY, status: ([A-Z]+), id: [0-9]+$", text, re.M)
    require(headers == ["NOERROR"], "DNS_STATUS")
    flags = re.findall(r"^;; flags: ([a-z ]+); QUERY: ([0-9]+), ANSWER: ([0-9]+), "
                       r"AUTHORITY: ([0-9]+), ADDITIONAL: [0-9]+$", text, re.M)
    require(len(flags) == 1, "DNS_HEADER")
    flag_words, questions, answers, authority = flags[0]
    flag_words = set(flag_words.split())
    require("qr" in flag_words and "tc" not in flag_words and questions == "1", "DNS_HEADER")
    sections = {"QUESTION": [], "ANSWER": [], "AUTHORITY": []}
    current = None
    seen = set()
    for line in text.splitlines():
        if line in (";; QUESTION SECTION:", ";; ANSWER SECTION:", ";; AUTHORITY SECTION:"):
            current = line.split()[1]
            require(current not in seen, "DNS_SECTION")
            seen.add(current)
        elif line and current and (not line.startswith(";") or current == "QUESTION" and not line.startswith(";;")):
            sections[current].append(line)
    require(len(sections["QUESTION"]) == 1
            and sections["QUESTION"][0].lstrip(";").split() == [name, "IN", record_type], "DNS_QUESTION")
    require(len(sections["ANSWER"]) == int(answers) and len(sections["AUTHORITY"]) == int(authority),
            "DNS_INCOMPLETE")

    def records(lines):
        result = []
        for line in lines:
            fields = line.split()
            require(len(fields) >= 5 and NAME.fullmatch(fields[0]) and fields[1].isdigit()
                    and fields[2] == "IN" and re.fullmatch(r"[A-Z][A-Z0-9]*", fields[3]), "DNS_RECORD")
            result.append((fields[0].lower(), fields[3], tuple(fields[4:])))
        return result

    return {"flags": flag_words, "answer": records(sections["ANSWER"]),
            "authority": records(sections["AUTHORITY"])}


class Transport:
    def query(self, name, record_type, server=None):
        require(NAME.fullmatch(name) and record_type in TYPES, "DNS_QUERY")
        require(server is None or NAME.fullmatch(server), "DNS_QUERY")
        command = ["/usr/bin/dig", "-r", "-4", "+tcp", "+time=5", "+tries=1", "+nosearch",
                   "+noall", "+comments", "+question", "+answer", "+authority", "+noedns",
                   "+nomultiline"]
        # 固定单行 RR，避免用户 digrc 或地区格式影响解析。
        if server is not None:
            command.extend(["@" + server, "+norecurse"])
        command.extend(["-q", name, "-t", record_type, "-c", "IN"])
        try:
            result = run_process(command, output_limit=65536, timeout=8,
                                 env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
        except ProcessOutputLimit:
            raise HealthError("DNS_RESPONSE_SIZE") from None
        except subprocess.TimeoutExpired:
            raise HealthError("DNS_TIMEOUT") from None
        except OSError:
            raise HealthError("DNS_TRANSPORT") from None
        require(result.returncode == 0, "DNS_TRANSPORT")
        try:
            text = result.stdout.decode("ascii")
        except UnicodeError:
            raise HealthError("DNS_RESPONSE_ENCODING") from None
        return parse_response(text, name, record_type)


def record_values(response, name, record_type):
    require(all(owner == name and kind == record_type for owner, kind, _ in response["answer"]), "DNS_RECORD_SET")
    values = []
    for _, _, fields in response["answer"]:
        require(len(fields) == 1, "DNS_RECORD")
        values.append(fields[0].lower())
    require(len(values) == len(set(values)), "DNS_RECORD_SET")
    return set(values)


def authoritative(response, zone):
    require("aa" in response["flags"], "DNS_NOT_AUTHORITATIVE")
    if not response["answer"]:
        negative_proof(response, zone)


def negative_proof(response, zone):
    soa = [fields for owner, kind, fields in response["authority"] if owner == zone and kind == "SOA"]
    require(len(soa) == 1 and len(soa[0]) == 7
            and NAME.fullmatch(soa[0][0]) and NAME.fullmatch(soa[0][1])
            and all(value.isdigit() for value in soa[0][2:]), "DNS_NEGATIVE_PROOF")


def check_dns(baseline, transport=None):
    """返回同轮全部脱敏检查；任一来源失败都保留，绝不退回其他来源放行。"""
    transport = transport or Transport()
    checks = []

    def attempt(label, action):
        try:
            action()
            checks.append({"check": "dns-weekly:" + label, "status": "passed"})
        except Exception as error:
            code = str(error) if isinstance(error, HealthError) else "DNS_CHECK_FAILED"
            checks.append({"check": "dns-weekly:" + label, "status": "failed", "code": code})

    def query(role, name, kind, server=None):
        response = transport.query(name, kind, server)
        if role == "authority":
            authoritative(response, ZONE)
        elif not response["answer"]:
            require(not any(kind == "NS" for _, kind, _ in response["authority"])
                    or any(owner == ZONE and kind == "SOA" for owner, kind, _ in response["authority"]),
                    "DNS_REFERRAL")
        return response

    for server in (None, *sorted(NAMESERVERS)):
        role = "recursive" if server is None else "authority"
        label = role + (":" + server if server else "")

        def ns(server=server, role=role):
            require(record_values(query(role, ZONE, "NS", server), ZONE, "NS") == NAMESERVERS, "DNS_NAMESERVERS")
        attempt(label + ":NS", ns)
        for host in HOSTS:
            for kind in ("A", "AAAA", "CNAME"):
                def target(server=server, role=role, name=host + ".", kind=kind):
                    values = record_values(query(role, name, kind, server), name, kind)
                    if kind == "A":
                        require(bool(values) and address_digest(values) == baseline["addressDigest"], "DNS_ADDRESS")
                    else:
                        require(not values, "DNS_UNEXPECTED_" + kind)
                attempt(label + ":" + host + ":" + kind, target)
        if server:
            def unsigned(server=server):
                response = query("authority", ZONE, "DNSKEY", server)
                require(not response["answer"], "DNS_UNEXPECTED_DNSKEY")
            attempt(label + ":DNSKEY", unsigned)

    def parent():
        candidates = record_values(transport.query(PARENT, "NS"), PARENT, "NS")
        require(0 < len(candidates) <= 32 and all(NAME.fullmatch(s) for s in candidates), "DNS_PARENT_DISCOVERY")
        server = sorted(candidates)[0]

        def delegation():
            response = transport.query(ZONE, "NS", server)
            # 委派可出现在 AUTHORITY 区；不得把子区 SOA 或空答当作成功委派。
            records = response["answer"] or response["authority"]
            require(bool(records) and all(owner == ZONE and kind == "NS" and len(fields) == 1
                                         for owner, kind, fields in records), "DNS_DELEGATION")
            values = [fields[0].lower() for _, _, fields in records]
            require(len(values) == len(set(values)) and set(values) == NAMESERVERS, "DNS_DELEGATION")
        attempt("parent:delegation", delegation)

        def ds():
            response = transport.query(ZONE, "DS", server)
            require(not response["answer"], "DNS_UNEXPECTED_DS")
            authoritative(response, PARENT)
        attempt("parent:DS", ds)
    attempt("parent:discovery", parent)
    return checks
