set -euo pipefail
umount /init
if grep -E ' - (9p|virtiofs|fuse.sshfs) ' /proc/self/mountinfo; then exit 1; fi
test "$(head -1 /proc/sys/fs/binfmt_misc/WSLInterop)" = disabled
test ! -e /mnt/c/Windows
test ! -e /mnt/d/Windows
cat /proc/self/mountinfo > /var/lib/sf-native-evidence/mountinfo.txt
export PATH=/opt/sf-native-node/bin:/usr/sbin:/usr/bin:/sbin:/bin
export SF_NATIVE_SOURCE_ROOT=/opt/software-factory
export SF_WORKER_TEST_CGROUP_ROOT=/sys/fs/cgroup/unified/sf-native-acceptance
cd /opt/software-factory
test "$(git rev-parse HEAD)" = 54bc0b9ff3b87435b2f22c5abcedb06cac5850a0
test -z "$(git status --porcelain)"
cat /proc/sys/kernel/random/boot_id > /var/lib/sf-native-evidence/batch-boot.txt
node --test --test-reporter=tap packages/test-harness/src/m6c3-worker-endpoint-linux-smoke.ts > /var/lib/sf-native-evidence/worker.tap 2>&1
bash scripts/ci/worker-isolation-tap-summary.sh /var/lib/sf-native-evidence/worker.tap
node --test --test-reporter=tap packages/test-harness/src/native-worker-guest.test.ts > /var/lib/sf-native-evidence/native-bootstrap.tap 2>&1
bash scripts/ci/worker-isolation-tap-summary.sh /var/lib/sf-native-evidence/native-bootstrap.tap
node --test --test-reporter=tap packages/test-harness/src/m6c3-worker-isolation.test.ts > /var/lib/sf-native-evidence/isolation.tap 2>&1
bash scripts/ci/worker-isolation-tap-summary.sh /var/lib/sf-native-evidence/isolation.tap
node --test --test-reporter=tap /var/lib/sf-native-evidence/network-cleanup-probe.mjs > /var/lib/sf-native-evidence/network-cleanup.tap 2>&1
bash scripts/ci/worker-isolation-tap-summary.sh /var/lib/sf-native-evidence/network-cleanup.tap
python3 - <<'MANIFEST'
from pathlib import Path
import subprocess,json,hashlib,datetime,re
root=Path('/var/lib/sf-native-evidence');source=Path('/opt/software-factory');cg=Path('/sys/fs/cgroup/unified/sf-native-acceptance')
boot=Path('/proc/sys/kernel/random/boot_id').read_text().strip();assert boot==(root/'batch-boot.txt').read_text().strip()
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=source,text=True).strip();assert sha=='54bc0b9ff3b87435b2f22c5abcedb06cac5850a0'
assert not subprocess.check_output(['git','status','--porcelain'],cwd=source,text=True).strip()
assert not list((cg/'software-factory.slice').glob('sf-task-*'))
assert 'populated 0' in (cg/'software-factory.slice/cgroup.events').read_text()
logs={};total=0
for name in ['worker.tap','native-bootstrap.tap','isolation.tap','network-cleanup.tap']:
 b=(root/name).read_bytes();t=b.decode();counts={k:int(re.search(r'^# '+k+r' (\d+)$',t,re.M)[1]) for k in ['tests','pass','fail','cancelled','skipped','todo']}
 assert counts['tests']==counts['pass'] and counts['fail']==counts['cancelled']==counts['skipped']==counts['todo']==0
 total+=counts['tests'];logs[name]={'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'summary':counts}
assert total==26
manifest={'schemaVersion':'sf-wsl2-guest-kernel-evidence-v1','status':'GUEST_KERNEL_TESTS_PASSED','recordedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSha':sha,'guestBootId':boot,'kernel':subprocess.check_output(['uname','-r'],text=True).strip(),'osRelease':Path('/etc/os-release').read_text(),'node':subprocess.check_output(['node','--version'],text=True).strip(),'cpuCount':int(subprocess.check_output(['nproc'],text=True)),'memTotal':Path('/proc/meminfo').read_text().splitlines()[0],'cmdline':Path('/proc/cmdline').read_text().strip(),'supervisorSha256':hashlib.sha256((source/'packages/wna/native/sf_sandbox_supervisor.c').read_bytes()).hexdigest(),'logs':logs,'totalTests':total,'postchecks':{'sameBootBeforeAfter':True,'sourceCleanBeforeAfter':True,'taskScopesRemaining':0,'cgroupPopulatedZero':True,'no9pInTestServiceNamespace':True,'noMountedWindowsDrivePaths':True,'interopDisabledForTestRun':True},'scope':'real Windows WSL2 Linux kernel and local guest worker tests; fixture measured profile in bootstrap; no production Windows HTTPS connector/Core pipeline acceptance'}
(root/'guest-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
MANIFEST
