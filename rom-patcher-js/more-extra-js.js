document.getElementById("versionSelect").innerHTML += "<option value='0'>DX 3.0.b (Beta)</option>";
document.getElementById("versionSelect").innerHTML += "<option value='1'>DX 3.0.0 (Latest)</option>";


document.getElementById("versionSelect").value = selectedVersion;

function changeVersion() {
	if (document.getElementById("versionSelect").value == 0) {
		window.location.href = "./DX_3_0_b"
	} else if (document.getElementById("versionSelect").value == 1) {
		window.location.href = "./DX_3_0_0"
	} 
}
