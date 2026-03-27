PKG_ID := $(shell yq e '.id' manifest.yaml)
PKG_VERSION := $(shell yq e '.version' manifest.yaml)
TS_FILES := $(shell find scripts -name '*.ts')

.DELETE_ON_ERROR:

all: verify

verify: $(PKG_ID).s9pk
	start-sdk verify s9pk $(PKG_ID).s9pk

install:
	start-cli package install $(PKG_ID).s9pk

$(PKG_ID).s9pk: manifest.yaml instructions.md icon.png LICENSE scripts/embassy.js docker-images/x86_64.tar docker-images/aarch64.tar
	start-sdk pack

scripts/embassy.js: $(TS_FILES)
	deno bundle scripts/embassy.ts scripts/embassy.js

docker-images/x86_64.tar: Dockerfile ../package.json ../src/**/*
	mkdir -p docker-images
	docker buildx build \
		--tag start9/$(PKG_ID)/main:$(PKG_VERSION) \
		--platform linux/amd64 \
		--build-arg PLATFORM=amd64 \
		-f Dockerfile \
		-o type=docker,dest=docker-images/x86_64.tar \
		..

docker-images/aarch64.tar: Dockerfile ../package.json ../src/**/*
	mkdir -p docker-images
	docker buildx build \
		--tag start9/$(PKG_ID)/main:$(PKG_VERSION) \
		--platform linux/arm64 \
		--build-arg PLATFORM=arm64 \
		-f Dockerfile \
		-o type=docker,dest=docker-images/aarch64.tar \
		..

clean:
	rm -rf docker-images scripts/embassy.js $(PKG_ID).s9pk

.PHONY: all verify install clean
