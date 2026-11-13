"""用固定无参数 TAT 命令读取生产证据；不记录凭证、响应正文或云资源标识。"""

import base64
import hashlib
import hmac
import http.client
import json
import re
import ssl
import subprocess
import sys
import time
from datetime import datetime, timezone

from ops.monitor.bounded_process import ProcessOutputLimit, run_process
from ops.monitor.public_health import HealthError, require


HOST = "tat.tencentcloudapi.com"
CONTENT_TYPE = "application/json; charset=utf-8"
SIGNED_HEADERS = "content-type;host;x-tc-action"
API_OUTPUT_LIMIT = 128 * 1024
EVIDENCE_LIMIT = 16 * 1024
COMMAND = b"#!/bin/sh\nexec /usr/bin/sudo -n /usr/local/sbin/axialmuse-monitor-snapshot\n"
COMMAND_SHA256 = hashlib.sha256(COMMAND).hexdigest()


def decode_json(data):
    def pairs(items):
        require(len(items) == len(dict(items)), "MONITOR_TAT_JSON")
        return dict(items)
    try:
        return json.loads(data, object_pairs_hook=pairs)
    except (ValueError, UnicodeError):
        raise HealthError("MONITOR_TAT_JSON") from None


def authorization(action, payload, secret_id, secret_key, timestamp):
    """TC3 固定 host/service 签名；凭证只存在于受限进程内存。"""
    require(action in ("DescribeCommands", "InvokeCommand", "DescribeInvocationTasks")
            and isinstance(secret_id, str) and 1 <= len(secret_id) <= 256
            and isinstance(secret_key, str) and 1 <= len(secret_key) <= 256
            and not any(ord(c) < 33 or ord(c) > 126 for c in secret_id + secret_key)
            and type(timestamp) is int and timestamp > 0, "MONITOR_TAT_CONFIG")
    date = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d")
    headers = f"content-type:{CONTENT_TYPE}\nhost:{HOST}\nx-tc-action:{action.lower()}\n"
    canonical = "POST\n/\n\n" + headers + "\n" + SIGNED_HEADERS + "\n" + hashlib.sha256(payload).hexdigest()
    scope = f"{date}/tat/tc3_request"
    to_sign = f"TC3-HMAC-SHA256\n{timestamp}\n{scope}\n" + hashlib.sha256(canonical.encode()).hexdigest()
    def sign(key, message):
        return hmac.new(key, message.encode(), hashlib.sha256).digest()
    key = sign(sign(sign(("TC3" + secret_key).encode(), date), "tat"), "tc3_request")
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, SignedHeaders={SIGNED_HEADERS}, Signature={signature}"


def request_once(action, body, region, secret_id, secret_key):
    require(region == "ap-shanghai" and isinstance(body, dict), "MONITOR_TAT_CONFIG")
    payload = json.dumps(body, separators=(",", ":"), ensure_ascii=True).encode()
    require(len(payload) <= 4096, "MONITOR_TAT_REQUEST")
    timestamp = int(time.time())
    headers = {"Content-Type": CONTENT_TYPE, "Host": HOST, "X-TC-Action": action,
               "X-TC-Version": "2020-10-28", "X-TC-Region": region, "X-TC-Timestamp": str(timestamp),
               "Authorization": authorization(action, payload, secret_id, secret_key, timestamp),
               "Connection": "close"}
    connection = http.client.HTTPSConnection(HOST, timeout=10, context=ssl.create_default_context())
    try:
        connection.request("POST", "/", body=payload, headers=headers)
        response = connection.getresponse()
        data = response.read(API_OUTPUT_LIMIT + 1)
        require(response.status == 200 and len(data) <= API_OUTPUT_LIMIT, "MONITOR_TAT_HTTP")
        parsed = decode_json(data)
        require(isinstance(parsed, dict) and isinstance(parsed.get("Response"), dict)
                and "Error" not in parsed["Response"], "MONITOR_TAT_API")
        return parsed["Response"]
    finally:
        connection.close()


def request_main():
    try:
        request = decode_json(sys.stdin.buffer.read(8193))
        require(isinstance(request, dict) and set(request) == {"action", "body", "region", "secretId", "secretKey"},
                "MONITOR_TAT_REQUEST")
        value = request_once(request["action"], request["body"], request["region"],
                             request["secretId"], request["secretKey"])
        sys.stdout.write(json.dumps({"response": value}, separators=(",", ":")))
    except Exception as error:
        code = str(error) if isinstance(error, HealthError) else "MONITOR_TAT_REQUEST"
        sys.stdout.write(json.dumps({"code": code}))


class TatTransport:
    def __init__(self, command_id, instance_id, command_sha256, secret_id, secret_key,
                 *, region="ap-shanghai", call=None, clock=time.monotonic, sleep=time.sleep, wall=time.time):
        require(isinstance(command_id, str) and re.fullmatch(r"cmd-[a-z0-9]{8,64}", command_id)
                and isinstance(instance_id, str) and re.fullmatch(r"(?:lhins|ins)-[a-z0-9]{8,64}", instance_id)
                and command_sha256 == COMMAND_SHA256
                and region == "ap-shanghai", "MONITOR_TAT_CONFIG")
        self.command_id, self.instance_id, self.command_sha256 = command_id, instance_id, command_sha256
        self.region, self.secret_id, self.secret_key = region, secret_id, secret_key
        self.call, self.clock, self.sleep, self.wall = call or self._call, clock, sleep, wall

    def _call(self, action, body, deadline):
        request = {"action": action, "body": body, "region": self.region,
                   "secretId": self.secret_id, "secretKey": self.secret_key}
        try:
            result = run_process([sys.executable, "-m", "ops.monitor.tat_transport", "--request"],
                                 input=json.dumps(request).encode(), output_limit=API_OUTPUT_LIMIT,
                                 deadline=deadline, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C.UTF-8"})
        except subprocess.TimeoutExpired:
            raise HealthError("MONITOR_TAT_TIMEOUT") from None
        except ProcessOutputLimit:
            raise HealthError("MONITOR_TAT_RESPONSE_SIZE") from None
        require(result.returncode == 0, "MONITOR_TAT_REQUEST")
        value = decode_json(result.stdout)
        if isinstance(value, dict) and set(value) == {"code"}:
            require(value["code"] in {"MONITOR_TAT_CONFIG", "MONITOR_TAT_REQUEST", "MONITOR_TAT_JSON",
                                      "MONITOR_TAT_HTTP", "MONITOR_TAT_API"}, "MONITOR_TAT_REQUEST")
            raise HealthError(value["code"])
        require(isinstance(value, dict) and set(value) == {"response"}, "MONITOR_TAT_REQUEST")
        return value["response"]

    def fetch(self):
        deadline = self.clock() + 80
        catalog = self.call("DescribeCommands", {"CommandIds": [self.command_id], "Limit": 2}, deadline)
        require(isinstance(catalog, dict) and catalog.get("TotalCount") == 1
                and isinstance(catalog.get("CommandSet"), list) and len(catalog["CommandSet"]) == 1,
                "MONITOR_TAT_COMMAND")
        command = catalog["CommandSet"][0]
        require(isinstance(command, dict) and command.get("CommandId") == self.command_id
                and command.get("EnableParameter") is False and command.get("CommandType") == "SHELL"
                and command.get("Username") == "axial-monitor" and command.get("WorkingDirectory") == "/"
                and type(command.get("Timeout")) is int and 1 <= command["Timeout"] <= 60
                and not command.get("OutputCOSBucketUrl"),
                "MONITOR_TAT_COMMAND")
        try:
            command_content = base64.b64decode(command["Content"], validate=True)
        except (KeyError, TypeError, ValueError):
            raise HealthError("MONITOR_TAT_COMMAND") from None
        require(hashlib.sha256(command_content).hexdigest() == self.command_sha256, "MONITOR_TAT_COMMAND")
        issued_at = self.wall()
        invocation = self.call("InvokeCommand", {"CommandId": self.command_id,
                               "InstanceIds": [self.instance_id]}, deadline)
        invocation_id = invocation.get("InvocationId") if isinstance(invocation, dict) else None
        require(isinstance(invocation_id, str) and re.fullmatch(r"inv-[a-z0-9]{8,64}", invocation_id),
                "MONITOR_TAT_INVOCATION")
        while self.clock() < deadline:
            result = self.call("DescribeInvocationTasks", {"Filters": [
                {"Name": "invocation-id", "Values": [invocation_id]}], "HideOutput": False, "Limit": 2}, deadline)
            require(isinstance(result, dict) and type(result.get("TotalCount")) is int
                    and isinstance(result.get("InvocationTaskSet"), list), "MONITOR_TAT_RESULT")
            total, tasks = result["TotalCount"], result["InvocationTaskSet"]
            require(total in (0, 1) and len(tasks) == total, "MONITOR_TAT_RESULT")
            if total == 1:
                task = tasks[0]
                require(isinstance(task, dict) and task.get("InvocationId") == invocation_id
                        and task.get("CommandId") == self.command_id and task.get("InstanceId") == self.instance_id,
                        "MONITOR_TAT_IDENTITY")
                state = task.get("TaskStatus")
                if state == "SUCCESS":
                    try:
                        created = datetime.fromisoformat(task["CreatedTime"])
                        require(created.tzinfo is not None, "MONITOR_TAT_FRESHNESS")
                        created_at = created.timestamp()
                    except (KeyError, TypeError, ValueError, OverflowError):
                        raise HealthError("MONITOR_TAT_FRESHNESS") from None
                    require(issued_at - 5 <= created_at <= self.wall() + 5, "MONITOR_TAT_FRESHNESS")
                    return self._output(task)
                require(state in ("PENDING", "DELIVERING", "DELIVER_DELAYED", "RUNNING"), "MONITOR_TAT_TERMINAL")
            remaining = deadline - self.clock()
            require(remaining > 0, "MONITOR_TAT_TIMEOUT")
            self.sleep(min(2, remaining))
        raise HealthError("MONITOR_TAT_TIMEOUT")

    def _output(self, task):
        document, result = task.get("CommandDocument"), task.get("TaskResult")
        require(isinstance(document, dict) and isinstance(result, dict)
                and document.get("CommandType") == "SHELL" and document.get("Username") == "axial-monitor"
                and document.get("WorkingDirectory") == "/" and type(document.get("Timeout")) is int
                and 1 <= document["Timeout"] <= 60
                and not document.get("OutputCOSBucketUrl")
                and type(result.get("ExitCode")) is int and result["ExitCode"] == 0
                and type(result.get("Dropped")) is int
                and result["Dropped"] == 0, "MONITOR_TAT_OUTPUT")
        try:
            content = base64.b64decode(document["Content"], validate=True)
            output = base64.b64decode(result["Output"], validate=True)
        except (KeyError, TypeError, ValueError):
            raise HealthError("MONITOR_TAT_OUTPUT") from None
        require(hashlib.sha256(content).hexdigest() == self.command_sha256, "MONITOR_TAT_COMMAND")
        require(len(output) <= EVIDENCE_LIMIT, "MONITOR_TAT_OUTPUT")
        return decode_json(output)


if __name__ == "__main__":
    require(sys.argv[1:] == ["--request"], "MONITOR_TAT_REQUEST")
    request_main()
