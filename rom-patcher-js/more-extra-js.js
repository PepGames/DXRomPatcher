document.getElementById("versionSelect").innerHTML += "<option value='0'>testpatch (Latest)</option>";


document.getElementById("versionSelect").value = selectedVersion;

function changeVersion() {
	if (document.getElementById("versionSelect").value == 0) {
		window.location.href = "./testpatch"
	} 
}
